// The core loop. One in-process interval drives it — no extra processes, no job queue library.
// Different PRs process concurrently; within a PR, jobs are strictly sequential (see
// db.claimNextJob) because Orca forks a second agent session if two automation runs overlap on
// the same worktree.
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import * as db from "./db.ts";
import * as orca from "./orca.ts";
import * as github from "./github.ts";
import { isDone, isLaunchFrame, stable } from "./logic.ts";
import { preamble, PREAMBLE_MARKER } from "./preamble.ts";
import { attachmentDir, downloadCommand, extensionOf, extractAttachmentUrls, rewritePrompt, type Attachment } from "./attachments.ts";

const POLL_MS = 5_000;
const BRANCH_POLL_MS = 3_000;
const BRANCH_POLL_MAX_MS = 120_000;
const TERMINAL_IDLE_TIMEOUT_MS = 4_000;
const DOWNLOAD_WAIT_MS = 5_000;
const DOWNLOAD_MAX_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CompletionResult = { outcome: "done"; content: string; truncated: boolean } | { outcome: "error"; reason: string };

export function createWorker(handle: DatabaseSync) {
  // PRs currently being processed, so tick() never claims a second job for the same PR while the
  // first is still in flight (claimNextJob already prevents this at the DB level too — this set
  // just avoids a wasted claim attempt every 10s).
  const active = new Set<number>();

  function enqueue(
    pr: number,
    headRef: string,
    commentId: number,
    author: string,
    prompt: string,
  ): { jobId: number; position: number } {
    db.ensureSessionRow(handle, pr, headRef);
    const { id, position } = db.enqueueJob(handle, pr, commentId, author, prompt);
    tick();
    return { jobId: id, position };
  }

  function tick(): void {
    for (const pr of db.queuedPrs(handle)) {
      if (active.has(pr)) continue;
      const job = db.claimNextJob(handle, pr);
      if (!job) continue;
      active.add(pr);
      processJob(job)
        .catch((err) => console.log(`processJob crashed pr=${job.pr} job=${job.id}: ${err?.stack ?? err}`))
        .finally(() => active.delete(pr));
    }
  }

  async function processJob(job: db.Job): Promise<void> {
    try {
      await github.react(job.comment_id, "eyes").catch((err) => console.log(`react failed pr=${job.pr}: ${err}`));

      // ensureSessionRow (called from enqueue, at request time) guarantees this row exists —
      // it's the only place head_ref is known, since the jobs table doesn't carry it.
      let session = db.getSession(handle, job.pr)!;
      const worktreeId = session.worktree_id ?? (await ensureWorktree(job.pr, session.head_ref));
      const prompt = preamble(session.head_ref, job.pr) + "\n\n" + (await stageAttachments(job, worktreeId));
      if (!session.automation_id) {
        const automationId = await orca.automationCreate(`pr-${job.pr}`, worktreeId, prompt);
        db.updateSession(handle, job.pr, { automation_id: automationId, state: "ready" });
        session = db.getSession(handle, job.pr)!;
      } else {
        await orca.automationEditPrompt(session.automation_id, prompt);
      }

      const runId = await orca.automationRun(session.automation_id!);
      db.setJobRunId(handle, job.id, runId);

      const result = await waitForCompletion(session, runId);
      if (result.outcome === "done") {
        db.markJobDone(handle, job.id, result.content);
        db.touchSession(handle, job.pr);
        await postResult(job, result.content, result.truncated);
      } else {
        db.markJobFailed(handle, job.id, result.reason);
        db.touchSession(handle, job.pr);
        await postFailure(job, result.reason);
      }
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      db.markJobFailed(handle, job.id, reason);
      await postFailure(job, reason).catch((e) => console.log(`comment failed pr=${job.pr}: ${e}`));
    } finally {
      await maybeFinishClosing(job.pr).catch((e) => console.log(`deferred close failed pr=${job.pr}: ${e}`));
    }
  }

  // Fresh worktree, then get it onto the real PR branch. The automation is created separately,
  // once the first prompt (with any attachments staged) is known.
  async function ensureWorktree(pr: number, headRef: string): Promise<string> {
    // `worktree create --base-branch X` hands X straight to git in the BASE checkout, which only
    // knows branches it has fetched — a PR branch pushed after the clone's last fetch fails with
    // "invalid reference" (seen live on PR 482). So fetch it there first, then base the throwaway
    // worktree branch on origin/<head>, which is guaranteed to exist afterwards.
    await runInWorktree(`${config.repoId}::${await orca.repoPath()}`, "fetch", `git fetch origin ${headRef}; exit`, pr);
    const worktreeId = await orca.worktreeCreate(`pr-${pr}`, `origin/${headRef}`);
    db.updateSession(handle, pr, { worktree_id: worktreeId });

    // worktreeCreate always creates a NEW branch at the base commit — it never checks out headRef
    // itself. `git checkout <head>` here creates the local tracking branch from origin/<head>.
    // We poll `worktree list` until Orca's own branch field flips to confirm the checkout landed.
    const checkoutCmd = `git fetch origin ${headRef} && git checkout ${headRef} && git branch --set-upstream-to=origin/${headRef}; exit`;
    const checkoutHandle = await orca.terminalCreate(worktreeId, "checkout", checkoutCmd);
    try {
      await pollUntilCheckedOut(worktreeId, headRef);
    } finally {
      await orca.terminalClose(checkoutHandle).catch((err) => console.log(`checkout terminalClose failed pr=${pr}: ${err}`));
    }
    return worktreeId;
  }

  // One-shot shell command in a worktree, waited on until its shell exits (the command must end
  // with `; exit`). Used for git plumbing and downloads that must finish before the agent runs.
  async function runInWorktree(worktreeId: string, title: string, command: string, pr: number): Promise<void> {
    const h = await orca.terminalCreate(worktreeId, title, command);
    try {
      const deadline = Date.now() + DOWNLOAD_MAX_MS;
      while (Date.now() < deadline && !(await orca.terminalWaitExit(h, DOWNLOAD_WAIT_MS))) {
        // keep waiting
      }
    } finally {
      await orca.terminalClose(h).catch((err) => console.log(`${title} terminalClose failed pr=${pr}: ${err}`));
    }
  }

  // Images in the comment: resolve each GitHub attachment URL to its short-lived signed URL
  // (needs our token), download them on the agent host via a one-shot terminal, and point the
  // prompt at the local files. A failed attachment is logged and left as a URL, not fatal.
  async function stageAttachments(job: db.Job, worktreeId: string): Promise<string> {
    const urls = extractAttachmentUrls(job.prompt);
    if (urls.length === 0) return job.prompt;
    const dir = attachmentDir(job.pr);
    const files: Array<{ signedUrl: string; path: string }> = [];
    const attachments: Attachment[] = [];
    for (const [i, url] of urls.entries()) {
      try {
        const signedUrl = await github.resolveAttachment(url);
        const path = `${dir}/${job.id}-${i + 1}.${extensionOf(signedUrl)}`;
        files.push({ signedUrl, path });
        attachments.push({ url, path });
      } catch (err) {
        console.log(`attachment skipped pr=${job.pr} ${url}: ${err}`);
      }
    }
    if (files.length === 0) return job.prompt;

    // Signed URLs expire in minutes, so download right away — not from inside the agent's turn.
    await runInWorktree(worktreeId, "attachments", downloadCommand(dir, files), job.pr);
    return rewritePrompt(job.prompt, attachments);
  }

  async function pollUntilCheckedOut(worktreeId: string, headRef: string): Promise<void> {
    const wantBranch = `refs/heads/${headRef}`;
    const deadline = Date.now() + BRANCH_POLL_MAX_MS;
    while (Date.now() < deadline) {
      const worktrees = await orca.worktreeList();
      const wt = worktrees.find((w) => w.id === worktreeId);
      if (wt?.branch === wantBranch) return;
      await sleep(BRANCH_POLL_MS);
    }
    throw new Error(`worktree ${worktreeId} did not check out ${headRef} within ${BRANCH_POLL_MAX_MS}ms`);
  }

  async function waitForCompletion(session: db.Session, runId: string): Promise<CompletionResult> {
    const deadline = Date.now() + config.runTimeoutMin * 60_000;
    // Resolved from this run's terminalSessionId, not reused from the session row: when the
    // previous live session is gone Orca silently starts a new one, and the stored handle would
    // point at a dead tab. The row keeps the latest handle only so teardown has something to close.
    let terminalHandle: string | undefined;
    let prevCapturedAt: string | null = null;

    while (Date.now() < deadline) {
      const runs = await orca.automationRuns(session.automation_id!);
      const run = runs.find((r) => r.id === runId);
      if (!run) {
        await sleep(POLL_MS);
        continue;
      }

      if (!terminalHandle && run.terminalSessionId) {
        const terminals = await orca.terminalList(session.worktree_id!);
        const match = terminals.find((t) => t.tabId === run.terminalSessionId);
        if (match) {
          terminalHandle = match.handle;
          db.updateSession(handle, session.pr, { terminal_handle: terminalHandle });
        }
      }

      if (run.status === "failed" || run.status === "cancelled" || run.status === "error") {
        return { outcome: "error", reason: run.error ? String(run.error) : `run ${run.status}` };
      }

      // Four things must agree before we trust a snapshot, because each alone has fooled us:
      //   status      — "completed" fires ~3s in on a fresh session, before the agent answered;
      //   tui-idle    — trivially true while the shell is still launching the agent (no TUI yet);
      //   launch frame — Orca's first capture is that pre-TUI frame echoing our own prompt;
      //   stability   — the capture is replaced later; two polls with the same capturedAt.
      const idle = terminalHandle ? await orca.terminalWaitIdle(terminalHandle, TERMINAL_IDLE_TIMEOUT_MS) : false;
      const snap = run.outputSnapshot;
      const capturedAt = snap?.capturedAt ?? null;
      const realAnswer = snap != null && !isLaunchFrame(snap.content, PREAMBLE_MARKER);
      if (isDone(run.status, idle) === "done" && realAnswer && stable([prevCapturedAt, capturedAt])) {
        return { outcome: "done", content: snap!.content, truncated: snap!.truncated };
      }
      prevCapturedAt = capturedAt;

      await sleep(POLL_MS);
    }
    return { outcome: "error", reason: `timed out after ${config.runTimeoutMin} minutes` };
  }

  async function postResult(job: db.Job, content: string, truncated: boolean): Promise<void> {
    const truncatedNote = truncated ? "\n\n⚠️ output truncated by Orca" : "";
    // Output goes inline, not folded: readers wanted the answer visible without a click.
    const body = `🐳 orca: done for @${job.author}'s request\n\n${content}${truncatedNote}`;
    await github.comment(job.pr, body);
  }

  async function postFailure(job: db.Job, reason: string): Promise<void> {
    await github.comment(job.pr, `🐳 orca: failed — ${reason}`);
  }

  // Never tears down a session while a job is running for it — defer to maybeFinishClosing,
  // called from processJob's `finally` once the in-flight job settles.
  async function closeSession(pr: number): Promise<boolean> {
    const session = db.getSession(handle, pr);
    if (!session || session.state === "closed") return false;
    db.failQueuedJobs(handle, pr, "session closed");
    if (active.has(pr)) {
      db.updateSession(handle, pr, { state: "closing" });
      return true;
    }
    await teardown(session);
    return true;
  }

  async function maybeFinishClosing(pr: number): Promise<void> {
    const session = db.getSession(handle, pr);
    if (session && session.state === "closing") {
      await teardown(session);
    }
  }

  async function teardown(session: db.Session): Promise<void> {
    // Each step is logged and attempted independently — one failing must not skip the rest.
    if (session.automation_id) {
      await orca.automationRemove(session.automation_id).catch((err) => console.log(`automationRemove failed pr=${session.pr}: ${err}`));
    }
    if (session.worktree_id) {
      // Removing the automation does NOT close its live terminal — close terminals explicitly.
      try {
        const terminals = await orca.terminalList(session.worktree_id);
        for (const t of terminals) {
          await orca.terminalClose(t.handle).catch((err) => console.log(`terminalClose failed pr=${session.pr}: ${err}`));
        }
      } catch (err) {
        console.log(`terminalList failed pr=${session.pr}: ${err}`);
      }
      await orca.worktreeRm(session.worktree_id).catch((err) => console.log(`worktreeRm failed pr=${session.pr}: ${err}`));
    }
    db.closeSessionRow(handle, session.pr);
  }

  async function sweepIdle(): Promise<void> {
    const cutoff = Date.now() - config.idleDays * 24 * 60 * 60 * 1000;
    for (const pr of db.idleSessions(handle, cutoff)) {
      await closeSession(pr).catch((err) => console.log(`idle sweep close failed pr=${pr}: ${err}`));
    }
  }

  return { enqueue, tick, closeSession, sweepIdle };
}

export type Worker = ReturnType<typeof createWorker>;
