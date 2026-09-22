// The core loop. One in-process interval drives it — no extra processes, no job queue library.
// Different PRs process concurrently; within a PR, jobs are strictly sequential (see
// db.claimNextJob) because Orca forks a second agent session if two automation runs overlap on
// the same worktree.
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import * as db from "./db.ts";
import * as orca from "./orca.ts";
import * as github from "./github.ts";
import { isDone, stable } from "./logic.ts";
import { preamble } from "./preamble.ts";

const POLL_MS = 5_000;
const BRANCH_POLL_MS = 3_000;
const BRANCH_POLL_MAX_MS = 120_000;
const STABILISE_POLL_MS = 5_000;
const STABILISE_MAX_MS = 30_000;
const TERMINAL_IDLE_TIMEOUT_MS = 4_000;

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
      if (!session.automation_id) {
        session = await ensureSession(job.pr, session.head_ref, job.prompt);
      } else {
        await orca.automationEditPrompt(session.automation_id, preamble(session.head_ref, job.pr) + "\n\n" + job.prompt);
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

  // Steps a-c from the brief: fresh worktree -> get onto the real PR branch -> one automation
  // we fire by hand. `firstPrompt` is the raw job prompt; preamble is applied once, here.
  async function ensureSession(pr: number, headRef: string, firstPrompt: string): Promise<db.Session> {
    const worktreeId = await orca.worktreeCreate(`pr-${pr}`, headRef);
    db.updateSession(handle, pr, { worktree_id: worktreeId });

    // worktreeCreate always creates a NEW branch at headRef's current commit — it never checks
    // out headRef itself. `terminal wait --for exit` doesn't report the shell exiting, so we
    // poll `worktree list` until Orca's own branch field flips to confirm the checkout landed.
    const checkoutCmd = `git fetch origin ${headRef} && git checkout ${headRef} && git branch --set-upstream-to=origin/${headRef}; exit`;
    const checkoutHandle = await orca.terminalCreate(worktreeId, "checkout", checkoutCmd);
    try {
      await pollUntilCheckedOut(worktreeId, headRef);
    } finally {
      await orca.terminalClose(checkoutHandle).catch((err) => console.log(`checkout terminalClose failed pr=${pr}: ${err}`));
    }

    const automationId = await orca.automationCreate(`pr-${pr}`, worktreeId, preamble(headRef, pr) + "\n\n" + firstPrompt);
    db.updateSession(handle, pr, { automation_id: automationId, state: "ready" });

    return db.getSession(handle, pr)!;
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

      const idle = terminalHandle ? await orca.terminalWaitIdle(terminalHandle, TERMINAL_IDLE_TIMEOUT_MS) : false;
      if (isDone(run.status, idle) === "done") {
        const snapshot = await stabiliseOutput(session.automation_id!, runId);
        return { outcome: "done", content: snapshot.content, truncated: snapshot.truncated };
      }

      await sleep(POLL_MS);
    }
    return { outcome: "error", reason: `timed out after ${config.runTimeoutMin} minutes` };
  }

  // A fresh session's first output capture can be a raw TUI frame that Orca later replaces with
  // the clean final message — wait for outputSnapshot.capturedAt to repeat before trusting it.
  async function stabiliseOutput(automationId: string, runId: string): Promise<{ content: string; truncated: boolean }> {
    const deadline = Date.now() + STABILISE_MAX_MS;
    let prevCapturedAt: string | null = null;
    let last: { content: string; capturedAt: string; truncated: boolean } | null = null;

    while (Date.now() < deadline) {
      const runs = await orca.automationRuns(automationId);
      const run = runs.find((r) => r.id === runId);
      const snap = run?.outputSnapshot ?? null;
      const curCapturedAt = snap?.capturedAt ?? null;
      if (snap) last = snap;

      if (stable([prevCapturedAt, curCapturedAt]) && snap) {
        return { content: snap.content, truncated: snap.truncated };
      }
      prevCapturedAt = curCapturedAt;
      await sleep(STABILISE_POLL_MS);
    }
    // Give up after 30s rather than failing the whole job — use whatever we last captured.
    return last ? { content: last.content, truncated: last.truncated } : { content: "", truncated: false };
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
