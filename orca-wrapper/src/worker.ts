// The core loop. One in-process interval drives it — no extra processes, no job queue library.
// Different sessions process concurrently; within a session, jobs are strictly sequential (see
// db.claimNextJob) because Orca forks a second agent session if two automation runs overlap on
// the same worktree. A session is either a PR-comment session (kind 'pr') or a Notion work-order
// session (kind 'task') — see db.ts for the schema and README.md for the two-run task flow.
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import * as db from "./db.ts";
import * as orca from "./orca.ts";
import * as github from "./github.ts";
import { isDone, isLaunchFrame, launchMarker, stable, renderPrompt, shq } from "./logic.ts";
import { preamble, PREAMBLE_MARKER } from "./preamble.ts";
import { attachmentDir, downloadCommand, extensionOf, extractAttachmentUrls, rewritePrompt, type Attachment } from "./attachments.ts";

const POLL_MS = 5_000;
const BRANCH_POLL_MS = 3_000;
const BRANCH_POLL_MAX_MS = 120_000;
const TERMINAL_IDLE_TIMEOUT_MS = 4_000;
const DOWNLOAD_WAIT_MS = 5_000;
const DOWNLOAD_MAX_MS = 60_000;
// Before sending the next prompt to a session that has already run, wait (config.busyWaitMin) for
// its agent to go idle: a run the wrapper gave up on (timeout) or lost track of (restart) is often
// still going, and a second `automations run` on top of it forks the session.
const AGENT_IDLE_POLL_MS = 10_000;

const NOTION_UPDATE_KIND = "notion-update";

const IMAGES_UNAVAILABLE_NOTE =
  "\n\nNote: the images in this comment could not be downloaded to this machine, so you cannot see " +
  "them. Say so in your reply instead of guessing what they show.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CompletionResult = { outcome: "done"; content: string; truncated: boolean } | { outcome: "error"; reason: string };

export type EnqueueResult =
  | { jobId: number; position: number; deduped?: true }
  | { rejected: "closing" };

export type CloseResult = "closed" | "closing" | false;

export function createWorker(handle: DatabaseSync) {
  // Session keys currently being processed, so tick() never claims a second job for the same
  // session while the first is still in flight (claimNextJob already prevents this at the DB
  // level too — this set just avoids a wasted claim attempt every tick).
  const active = new Set<string>();

  // Re-running the workflow redelivers the same comment (same id): hand back the job we already
  // have instead of running the prompt twice. A session that is shutting down (/orca stop while a
  // job runs) takes nothing new — it would run against an automation that's about to be removed.
  function enqueuePrJob(pr: number, headRef: string, commentId: number, author: string, prompt: string): EnqueueResult {
    const dup = db.findJobByCommentId(handle, commentId);
    if (dup) return { jobId: dup.id, position: db.positionOf(handle, dup), deduped: true };
    const existing = db.getSessionByPr(handle, pr);
    if (existing?.state === "closing") return { rejected: "closing" };
    const session = db.ensurePrSession(handle, pr, headRef);
    const { id, position } = db.enqueueJob(handle, session.key, commentId, author, prompt);
    tick();
    return { jobId: id, position };
  }

  // POST /tasks. `prompt` is required and Notion-authored (n8n passes it through verbatim) — a
  // live session for the WO gets it enqueued as a follow-up job (the normal queue/run/wait path,
  // using THIS request's prompt, not the session's original one); otherwise a fresh task session
  // is created, `prompt` is kept on it as `prompt_template` for reference, and this is its first
  // job. Either way, buildPrompt renders the job's own `prompt` at run time (see logic.renderPrompt).
  // The same prompt already waiting or running for the WO is a duplicate delivery, not a new ask.
  function enqueueTask(
    wo: number,
    notionUrl: string,
    title: string,
    author: string,
    branch: string,
    repoAppLine: string | null,
    prompt: string,
  ): { key: string } & EnqueueResult {
    const key = db.taskKey(wo);
    const existing = db.getSession(handle, key);
    if (existing && existing.state !== "closed") {
      if (existing.state === "closing") return { key, rejected: "closing" };
      const dup = db.findActiveDuplicate(handle, key, prompt);
      if (dup) return { key, jobId: dup.id, position: db.positionOf(handle, dup), deduped: true };
      const { id, position } = db.enqueueJob(handle, key, null, author, prompt);
      tick();
      return { key, jobId: id, position };
    }
    db.ensureTaskSession(handle, wo, notionUrl, title, branch, repoAppLine, prompt);
    const { id, position } = db.enqueueJob(handle, key, null, author, prompt);
    tick();
    return { key, jobId: id, position };
  }

  function tick(): void {
    for (const key of db.queuedSessionKeys(handle)) {
      if (active.has(key)) continue;
      const job = db.claimNextJob(handle, key);
      if (!job) continue;
      active.add(key);
      processJob(job)
        .catch((err) => console.log(`processJob crashed key=${key} job=${job.id}: ${err?.stack ?? err}`))
        .finally(() => active.delete(key));
    }
  }

  async function processJob(job: db.Job): Promise<void> {
    try {
      if (job.comment_id != null) {
        await github.react(job.comment_id, "eyes").catch((err) => console.log(`react failed key=${job.session_key}: ${err}`));
      }

      // ensurePrSession/ensureTaskSession (called at request time, before enqueueJob) guarantee
      // this row exists — it's the only place head_ref/notion fields are known, since jobs don't
      // carry them.
      let session = db.getSession(handle, job.session_key)!;
      if (!session.worktree_id) {
        await ensureWorktree(session);
        session = db.getSession(handle, job.session_key)!;
      }

      if (session.automation_id && !(await waitUntilAgentIdle(session))) {
        throw new Error(
          "the agent is still busy with an earlier request (one the wrapper stopped waiting for, or lost " +
            "track of in a restart). Nothing was sent; ask again once it has finished",
        );
      }

      const prompt = await buildPrompt(session, job, session.worktree_id!);
      if (!session.automation_id) {
        const automationId = await orca.automationCreate(session.key, session.worktree_id!, prompt);
        db.updateSession(handle, session.key, { automation_id: automationId, state: "ready" });
        session = db.getSession(handle, session.key)!;
      } else {
        await orca.automationEditPrompt(session.automation_id, prompt);
      }

      const runId = await orca.automationRun(session.automation_id!);
      db.setJobRunId(handle, job.id, runId);

      // PR sessions always start with the same hard-coded preamble, so PREAMBLE_MARKER alone spots
      // the terminal echoing it back. A task's prompt is Notion-authored and varies per session (and
      // per follow-up), so its own first 40 chars are the marker instead — or none, for a prompt
      // too short to be told apart from an answer (see logic.launchMarker).
      const marker = session.kind === "pr" || job.comment_id != null ? PREAMBLE_MARKER : launchMarker(prompt);
      const result = await waitForCompletion(session, runId, marker);
      if (result.outcome === "done") {
        db.markJobDone(handle, job.id, result.content);
        db.touchSession(handle, session.key);
        await handleCompletion(session, job, result.content, result.truncated);
      } else {
        db.markJobFailed(handle, job.id, result.reason);
        db.touchSession(handle, session.key);
        await handleFailure(session, job, result.reason);
      }
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      db.markJobFailed(handle, job.id, reason);
      const session = db.getSession(handle, job.session_key);
      if (session) {
        await handleFailure(session, job, reason).catch((e) => console.log(`comment failed key=${job.session_key}: ${e}`));
      }
    } finally {
      await maybeFinishClosing(job.session_key).catch((e) => console.log(`deferred close failed key=${job.session_key}: ${e}`));
    }
  }

  // True once the session's agent terminal reports tui-idle. No handle yet (first run) or a handle
  // Orca no longer knows (the agent is gone; Orca starts a fresh one on the next run) both count
  // as idle — there is nothing to run on top of.
  async function waitUntilAgentIdle(session: db.Session): Promise<boolean> {
    if (!session.terminal_handle) return true;
    const deadline = Date.now() + config.busyWaitMin * 60_000;
    while (Date.now() < deadline) {
      try {
        if (await orca.terminalWaitIdle(session.terminal_handle, AGENT_IDLE_POLL_MS)) return true;
      } catch (err) {
        if (err instanceof orca.OrcaError && err.code === "terminal_handle_stale") return true;
        throw err;
      }
      await sleep(1_000); // `terminal wait` normally blocks for the full poll; don't spin if it returns early
    }
    return false;
  }

  // The worktreeId prefix for reaching the BASE checkout (not any worktree) via `orca terminal
  // create --worktree`, needed to run `git fetch` there before basing a throwaway branch on a ref
  // the base checkout hasn't seen yet.
  async function baseWorktreeRef(): Promise<string> {
    return `${config.repoId}::${await orca.repoPath()}`;
  }

  // Fresh worktree, then get it onto the target branch. The automation is created separately,
  // once the first prompt (with any attachments staged, for kind 'pr') is known.
  async function ensureWorktree(session: db.Session): Promise<void> {
    if (session.kind === "pr") {
      await ensurePrWorktree(session);
    } else {
      await ensureTaskWorktree(session);
    }
  }

  async function ensurePrWorktree(session: db.Session): Promise<void> {
    const headRef = session.head_ref!;
    // `worktree create --base-branch X` hands X straight to git in the BASE checkout, which only
    // knows branches it has fetched — a PR branch pushed after the clone's last fetch fails with
    // "invalid reference" (seen live on PR 482). So fetch it there first, then base the throwaway
    // worktree branch on origin/<head>, which is guaranteed to exist afterwards.
    await runInWorktree(await baseWorktreeRef(), "fetch", `git fetch origin ${shq(headRef)}; exit`, session.key);
    const worktreeId = await orca.worktreeCreate(session.key, `origin/${headRef}`);

    // Put the worktree on a local branch of our own that tracks origin/<head>, rather than on
    // <head> itself: git refuses to check out a branch that another worktree of the same clone
    // already has, and on the agent host other sessions routinely do (seen live on PR 492). The
    // agent pulls from the upstream and pushes with HEAD:<head> (see preamble.ts).
    const local = localBranchFor(session);
    const origin = `origin/${headRef}`;
    const checkoutCmd = `git fetch origin ${shq(headRef)} && git checkout -B ${shq(local)} ${shq(origin)} && git branch --set-upstream-to=${shq(origin)}; exit`;
    await checkOutOrDiscard(session, worktreeId, checkoutCmd, local, `PR branch ${headRef}`);
  }

  async function ensureTaskWorktree(session: db.Session): Promise<void> {
    const branch = session.head_ref!; // the WO's own branch, e.g. claude/WO-12-campaign-owner-credit
    await runInWorktree(await baseWorktreeRef(), "fetch", `git fetch origin dev; exit`, session.key);
    // `--name` is only a hint: Orca sanitises slashes and may add a user prefix (e.g. turns this
    // into `ziveso/claude-WO-12-x`), so its own branch is never the one we want.
    const worktreeId = await orca.worktreeCreate(branch, "origin/dev");

    // One work order, one branch, one PR: when the branch is already on origin (the WO was
    // dispatched before), carry on from it; otherwise create it off origin/dev and push it right
    // away, before the agent runs, so the wrapper can always open a PR later and the agent has an
    // upstream to push to. Never reset an existing branch back to dev.
    const b = shq(branch);
    const ob = shq(`origin/${branch}`);
    const checkoutCmd =
      `if git fetch origin ${b}; then git checkout -B ${b} ${ob} && git branch --set-upstream-to=${ob}; ` +
      `else git checkout -B ${b} origin/dev && git push -u origin ${b}; fi; exit`;
    await checkOutOrDiscard(session, worktreeId, checkoutCmd, branch, `work order branch ${branch}`);
  }

  // Runs the checkout in the new worktree and waits for Orca to report `branch`. The worktree is
  // only recorded on the session once that lands: recording it first meant a failed checkout was
  // never retried — the next job skipped ensureWorktree and ran on Orca's own branch (H-15).
  async function checkOutOrDiscard(session: db.Session, worktreeId: string, command: string, branch: string, what: string): Promise<void> {
    const checkoutHandle = await orca.terminalCreate(worktreeId, "checkout", command);
    try {
      await pollUntilCheckedOut(worktreeId, branch);
    } catch (err: any) {
      await orca.worktreeRm(worktreeId).catch((e) => console.log(`discarding worktree failed key=${session.key}: ${e}`));
      throw new Error(`couldn't check out the ${what} in a fresh worktree (${err?.message ?? err}). Is it still on origin?`);
    } finally {
      await orca.terminalClose(checkoutHandle).catch((err) => console.log(`checkout terminalClose failed key=${session.key}: ${err}`));
    }
    db.updateSession(handle, session.key, { worktree_id: worktreeId });
  }

  // Per session, not per PR: a leftover worktree from an earlier session of the same PR may still
  // hold orca/pr-<n>, and a name that's taken is exactly the collision this avoids.
  function localBranchFor(session: db.Session): string {
    return `orca/pr-${session.pr}-${session.created_at.toString(36)}`;
  }

  // One-shot shell command in a worktree, waited on until its shell exits (the command must end
  // with `; exit`). Used for git plumbing and downloads that must finish before the agent runs.
  // Returns false if it was still running at the deadline (it is closed either way).
  async function runInWorktree(worktreeId: string, title: string, command: string, sessionKey: string): Promise<boolean> {
    const h = await orca.terminalCreate(worktreeId, title, command);
    try {
      const deadline = Date.now() + DOWNLOAD_MAX_MS;
      while (Date.now() < deadline) {
        if (await orca.terminalWaitExit(h, DOWNLOAD_WAIT_MS)) return true;
      }
      console.log(`${title} still running after ${DOWNLOAD_MAX_MS}ms key=${sessionKey}`);
      return false;
    } finally {
      await orca.terminalClose(h).catch((err) => console.log(`${title} terminalClose failed key=${sessionKey}: ${err}`));
    }
  }

  // Images in the comment: resolve each GitHub attachment URL to its short-lived signed URL
  // (needs our token), download them on the agent host via a one-shot terminal, and point the
  // prompt at the local files. A failed attachment is logged and left as a URL, not fatal.
  // PR sessions only — a task's trigger is a Notion row, not a GitHub comment.
  async function stageAttachments(job: db.Job, worktreeId: string, pr: number): Promise<string> {
    const urls = extractAttachmentUrls(job.prompt);
    if (urls.length === 0) return job.prompt;
    const dir = attachmentDir(pr);
    const files: Array<{ signedUrl: string; path: string }> = [];
    const attachments: Attachment[] = [];
    for (const [i, url] of urls.entries()) {
      try {
        const signedUrl = await github.resolveAttachment(url);
        const path = `${dir}/${job.id}-${i + 1}.${extensionOf(signedUrl)}`;
        files.push({ signedUrl, path });
        attachments.push({ url, path });
      } catch (err) {
        console.log(`attachment skipped pr=${pr} ${url}: ${err}`);
      }
    }
    if (files.length === 0) return job.prompt;

    // Signed URLs expire in minutes, so download right away — not from inside the agent's turn.
    // If the download never finished, pointing the agent at those paths would have it describe
    // files that may not exist; keep the URLs and say plainly that the images aren't available.
    const finished = await runInWorktree(worktreeId, "attachments", downloadCommand(dir, files), `pr-${pr}`);
    if (!finished) return job.prompt + IMAGES_UNAVAILABLE_NOTE;
    return rewritePrompt(job.prompt, attachments);
  }

  // Full text handed to `automations create`/`edit`. PR jobs get the ground-rules preamble plus
  // the comment's own text (with attachment URLs rewritten to local paths). Task jobs get their
  // own `prompt` (n8n/Notion-authored, first run or follow-up — see enqueueTask) rendered against
  // the session's values, except the auto-generated Notion-writeback job, which is sent exactly as
  // stored (see NOTION_UPDATE_KIND in handleCompletion).
  async function buildPrompt(session: db.Session, job: db.Job, worktreeId: string): Promise<string> {
    // Any job that came from a PR comment — including an /orca comment on a work order's PR — gets
    // the PR preamble and its images staged. Without it an /orca on a WO-PR reached the agent as
    // bare comment text: no pull first, no "don't open PRs", no images (H-05).
    if (session.kind === "pr" || (job.comment_id != null && session.pr)) {
      return preamble(session.head_ref!, session.pr!) + "\n\n" + (await stageAttachments(job, worktreeId, session.pr!));
    }
    if (job.kind === NOTION_UPDATE_KIND) return job.prompt;
    return renderPrompt(job.prompt, {
      branch: session.head_ref ?? "",
      wo: session.wo != null ? String(session.wo) : "",
      title: session.title ?? "",
      notion_url: session.notion_url ?? "",
      repo_app: session.repo_app ?? "",
    });
  }

  async function pollUntilCheckedOut(worktreeId: string, branch: string): Promise<void> {
    const wantBranch = `refs/heads/${branch}`;
    const deadline = Date.now() + BRANCH_POLL_MAX_MS;
    while (Date.now() < deadline) {
      const worktrees = await orca.worktreeList();
      const wt = worktrees.find((w) => w.id === worktreeId);
      if (wt?.branch === wantBranch) return;
      await sleep(BRANCH_POLL_MS);
    }
    throw new Error(`worktree ${worktreeId} did not check out ${branch} within ${BRANCH_POLL_MAX_MS}ms`);
  }

  async function waitForCompletion(session: db.Session, runId: string, marker: string): Promise<CompletionResult> {
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
          db.updateSession(handle, session.key, { terminal_handle: terminalHandle });
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
      const realAnswer = snap != null && !isLaunchFrame(snap.content, marker);
      if (isDone(run.status, idle) === "done" && realAnswer && stable([prevCapturedAt, capturedAt])) {
        return { outcome: "done", content: snap!.content, truncated: snap!.truncated };
      }
      prevCapturedAt = capturedAt;

      await sleep(POLL_MS);
    }
    return { outcome: "error", reason: `timed out after ${config.runTimeoutMin} minutes` };
  }

  // `who` is "@login" for PR jobs (the commenter's GitHub login) but a plain name for task jobs:
  // that author comes from n8n/Notion, and @-mentioning it would ping whoever owns that handle.
  async function postResult(pr: number, who: string, content: string, truncated: boolean): Promise<void> {
    const truncatedNote = truncated ? "\n\n⚠️ output truncated by Orca" : "";
    // Output goes inline, not folded: readers wanted the answer visible without a click.
    const body = `🐳 orca: done for ${who}'s request\n\n${content}${truncatedNote}`;
    await github.comment(pr, body);
  }

  async function postFailure(pr: number, reason: string): Promise<void> {
    await github.comment(pr, `🐳 orca: failed — ${reason}`);
  }

  // Routes a finished run's output. PR sessions always post a comment (unchanged from before
  // tasks existed). Task sessions branch three ways: the Notion-writeback job's output is logged,
  // never posted; a task whose branch already has a PR posts a comment exactly like a PR job; a
  // task with no PR yet decides whether to open one now (see the two-run flow in README.md).
  async function handleCompletion(session: db.Session, job: db.Job, content: string, truncated: boolean): Promise<void> {
    if (session.kind === "pr") {
      await postResult(session.pr!, `@${job.author}`, content, truncated);
      return;
    }
    if (job.kind === NOTION_UPDATE_KIND) {
      console.log(`task ${session.key}: notion update — ${content}`);
      return;
    }
    if (session.pr) {
      await postResult(session.pr, job.author, content, truncated);
      return;
    }

    const branch = session.head_ref!;
    const aheadBy = await github.compareAhead("dev", branch);
    if (aheadBy === 0) {
      console.log(`task ${session.key}: no commits pushed, no PR opened`);
      return;
    }

    // One work order, one PR. A re-dispatched WO (new session after the old one closed) finds the
    // PR its branch already has: open → answer there; closed without merging → reopen it; merged →
    // that work is done, so a new PR for the new commits.
    const existing = await github.findPullByHead(branch);
    let pr: { number: number; html_url: string };
    if (existing && !existing.merged) {
      if (existing.state === "closed") await github.reopenPullRequest(existing.number);
      pr = existing;
      db.updateSession(handle, session.key, { pr: pr.number, head_ref: branch });
      await postResult(pr.number, job.author, content, truncated);
    } else {
      const body = `Notion: ${session.notion_url}\n\n${content}`;
      pr = await github.createPullRequest({ title: `WO-${session.wo}: ${session.title}`, head: branch, base: "dev", body });
      db.updateSession(handle, session.key, { pr: pr.number, head_ref: branch });
    }

    const notionPrompt =
      `The pull request is open: ${pr.html_url} (#${pr.number}). Using your Notion tools, update the ` +
      `work order page ${session.notion_url}: set the property \`PR\` to ${pr.html_url}, \`PR Number\` ` +
      `to ${pr.number}, \`Branch\` to \`${branch}\`, \`Stage\` to \`In PR\`, and \`Last Agent Run\` to ` +
      `now. Do not change code. Reply with exactly which properties you updated.`;
    db.enqueueJob(handle, session.key, null, "orca", notionPrompt, NOTION_UPDATE_KIND);
    tick();
  }

  async function handleFailure(session: db.Session, job: db.Job, reason: string): Promise<void> {
    if (session.kind === "pr") {
      await postFailure(session.pr!, reason);
      return;
    }
    if (job.kind === NOTION_UPDATE_KIND) {
      console.log(`task ${session.key}: notion update failed — ${reason}`);
      return;
    }
    if (session.pr) {
      await postFailure(session.pr, reason);
      return;
    }
    // No PR to comment on yet (this may be the very first run, e.g. it failed before pushing
    // anything) — nothing in GitHub or Notion to tell, so just log it. A follow-up POST /tasks
    // can retry the session.
    console.log(`task ${session.key}: run failed before any PR — ${reason}`);
  }

  // Never tears down a session while a job is running for it — defer to maybeFinishClosing,
  // called from processJob's `finally` once the in-flight job settles. "closing" means exactly
  // that: the current job still finishes and posts its answer first.
  async function closeSession(key: string): Promise<CloseResult> {
    const session = db.getSession(handle, key);
    if (!session || session.state === "closed") return false;
    db.failQueuedJobs(handle, key, "session closed");
    if (active.has(key)) {
      db.updateSession(handle, key, { state: "closing" });
      return "closing";
    }
    await teardown(session);
    return "closed";
  }

  // Jobs that were running when the wrapper last stopped (db.markRunningJobsFailed at startup).
  // Their answer is lost and the agent may or may not have acted, so tell each PR rather than
  // leave only the 👀 reaction behind. A task with no PR yet has nowhere to say it but the log.
  async function notifyInterrupted(jobs: db.Job[]): Promise<void> {
    for (const job of jobs) {
      const session = db.getSession(handle, job.session_key);
      if (!session?.pr || job.kind === NOTION_UPDATE_KIND) {
        console.log(`restart interrupted job=${job.id} key=${job.session_key} (no PR to tell)`);
        continue;
      }
      await github
        .comment(
          session.pr,
          "🐳 orca: interrupted — the wrapper restarted while this request was running, so no answer was " +
            "captured. The agent may already have changed files or pushed; check the branch before asking again.",
        )
        .catch((err) => console.log(`restart notice failed key=${job.session_key}: ${err}`));
    }
  }

  async function maybeFinishClosing(key: string): Promise<void> {
    const session = db.getSession(handle, key);
    if (session && session.state === "closing") {
      await teardown(session);
    }
  }

  async function teardown(session: db.Session): Promise<void> {
    // Each step is logged and attempted independently — one failing must not skip the rest.
    if (session.automation_id) {
      await orca.automationRemove(session.automation_id).catch((err) => console.log(`automationRemove failed key=${session.key}: ${err}`));
    }
    if (session.worktree_id) {
      // Removing the automation does NOT close its live terminal — close terminals explicitly.
      try {
        const terminals = await orca.terminalList(session.worktree_id);
        for (const t of terminals) {
          await orca.terminalClose(t.handle).catch((err) => console.log(`terminalClose failed key=${session.key}: ${err}`));
        }
      } catch (err) {
        console.log(`terminalList failed key=${session.key}: ${err}`);
      }
      await orca.worktreeRm(session.worktree_id).catch((err) => console.log(`worktreeRm failed key=${session.key}: ${err}`));
      if (session.kind === "pr") {
        // Our per-session branch (see localBranchFor) outlives the worktree otherwise.
        const local = shq(localBranchFor(session));
        await runInWorktree(await baseWorktreeRef(), "cleanup", `git branch -D ${local}; exit`, session.key).catch((err) =>
          console.log(`branch cleanup failed key=${session.key}: ${err}`),
        );
      }
    }
    db.closeSessionRow(handle, session.key);
  }

  async function sweepIdle(): Promise<void> {
    const cutoff = Date.now() - config.idleDays * 24 * 60 * 60 * 1000;
    for (const key of db.idleSessions(handle, cutoff)) {
      await closeSession(key).catch((err) => console.log(`idle sweep close failed key=${key}: ${err}`));
    }
  }

  return { enqueuePrJob, enqueueTask, tick, closeSession, sweepIdle, notifyInterrupted };
}

export type Worker = ReturnType<typeof createWorker>;
