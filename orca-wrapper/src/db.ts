// SQLite state, in plain functions over a shared DatabaseSync handle (no ORM, no query builder —
// the schema is two small tables). Callers pass the handle in so tests can use ":memory:".
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SessionKind = "pr" | "task";
export type SessionState = "creating" | "ready" | "closing" | "closed";
export type JobState = "queued" | "running" | "done" | "failed";
// The one job kind that isn't a normal PR/task turn: the auto-enqueued follow-up that asks the
// agent to write the freshly-opened PR back onto its Notion row. Its output is logged, never
// posted as a PR comment (see worker.ts's handleCompletion).
export type JobKind = "notion-update" | null;

// One row per live agent session, keyed by a string that's `pr-<n>` for a plain PR-comment
// session or `wo-<n>` for a Notion work order (see prKey/taskKey). A task session's `pr` starts
// NULL and is filled in once the wrapper opens its PR — from that point on, `/pr/{n}` routes and
// a task session refer to the exact same row (see getSessionByPr).
export interface Session {
  key: string;
  kind: SessionKind;
  pr: number | null;
  head_ref: string | null; // PR head branch (kind 'pr') or the WO's own branch (kind 'task')
  worktree_id: string | null;
  automation_id: string | null;
  terminal_handle: string | null;
  state: SessionState;
  created_at: number;
  last_activity: number;
  notion_url: string | null; // kind 'task' only
  wo: number | null; // kind 'task' only
  title: string | null; // kind 'task' only
  repo_app: string | null; // kind 'task' only — "Repo / App" multi-select, joined for the preamble
  prompt_template: string | null; // kind 'task' only — the first run's `prompt` (n8n/Notion-authored), kept for reference; see logic.renderPrompt
}

export interface Job {
  id: number;
  session_key: string;
  kind: JobKind;
  comment_id: number | null; // null for task jobs — there's no GitHub comment behind them
  author: string;
  prompt: string;
  state: JobState;
  run_id: string | null;
  output: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export function prKey(pr: number): string {
  return `pr-${pr}`;
}

export function taskKey(wo: number): string {
  return `wo-${wo}`;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;"); // no-op (falls back to 'memory') for :memory: databases
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      pr INTEGER,
      head_ref TEXT,
      worktree_id TEXT,
      automation_id TEXT,
      terminal_handle TEXT,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      notion_url TEXT,
      wo INTEGER,
      title TEXT,
      repo_app TEXT,
      prompt_template TEXT
    );
  `);
  // Looked up on every /pr route and by ensurePrSession — a task session's pr column is set once
  // its PR opens, so this index also serves "does this PR already belong to a task session".
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_pr ON sessions(pr);");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      kind TEXT,
      comment_id INTEGER,
      author TEXT NOT NULL,
      prompt TEXT NOT NULL,
      state TEXT NOT NULL,
      run_id TEXT,
      output TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
  `);
  // Startup recovery: a job stuck "running" means the wrapper died mid-run. Never resend a
  // prompt on restart — the agent may already have acted on it — so we fail it instead.
  markRunningJobsFailed(db);
  return db;
}

export function markRunningJobsFailed(db: DatabaseSync): void {
  db.prepare("UPDATE jobs SET state = 'failed', error = 'wrapper restarted', finished_at = ? WHERE state = 'running'").run(
    Date.now(),
  );
}

// --- sessions -----------------------------------------------------------

export function getSession(db: DatabaseSync, key: string): Session | undefined {
  return db.prepare("SELECT * FROM sessions WHERE key = ?").get(key) as Session | undefined;
}

// Most recent row wins when more than one matches (e.g. a closed 'pr' session from a previous PR
// number lifecycle sitting next to a live 'task' session whose PR now points at the same number —
// can't happen today since numbers aren't reused, but rowid DESC makes the tie-break explicit
// rather than relying on SQLite's unspecified default order).
export function getSessionByPr(db: DatabaseSync, pr: number): Session | undefined {
  return db.prepare("SELECT * FROM sessions WHERE pr = ? ORDER BY rowid DESC LIMIT 1").get(pr) as Session | undefined;
}

export function listOpenSessions(db: DatabaseSync): Session[] {
  return db.prepare("SELECT * FROM sessions WHERE state != 'closed'").all() as unknown as Session[];
}

// Called when a prompt comes in for a PR. If the PR already has a live (non-closed) session —
// including one opened from a task work order, once the wrapper has recorded its PR number — that
// row is reused, not duplicated: only head_ref may need updating (the workflow resends it on
// every comment, and it's the only place head_ref is known before the worker runs). Otherwise a
// fresh 'pr' session is created, keyed by PR number alone.
export function ensurePrSession(db: DatabaseSync, pr: number, headRef: string): Session {
  const existing = getSessionByPr(db, pr);
  if (existing && existing.state !== "closed") {
    if (existing.head_ref !== headRef) {
      db.prepare("UPDATE sessions SET head_ref = ? WHERE key = ?").run(headRef, existing.key);
      return getSession(db, existing.key)!;
    }
    return existing;
  }
  const key = prKey(pr);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (key, kind, pr, head_ref, worktree_id, automation_id, terminal_handle, state, created_at, last_activity)
     VALUES (?, 'pr', ?, ?, NULL, NULL, NULL, 'creating', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       pr = excluded.pr,
       head_ref = excluded.head_ref,
       worktree_id = NULL,
       automation_id = NULL,
       terminal_handle = NULL,
       state = 'creating',
       last_activity = excluded.last_activity`,
  ).run(key, pr, headRef, now, now);
  return getSession(db, key)!;
}

// Called from POST /tasks when the WO's key has no live session yet. `pr` stays NULL until
// worker.ts opens the PR. ON CONFLICT covers a previously-closed session for the same WO getting
// a fresh /tasks POST: reset to a clean 'creating' row rather than resurrecting stale worktree/
// automation ids.
export function ensureTaskSession(
  db: DatabaseSync,
  wo: number,
  notionUrl: string,
  title: string,
  branch: string,
  repoApp: string | null,
  promptTemplate: string,
): Session {
  const key = taskKey(wo);
  const existing = getSession(db, key);
  if (existing && existing.state !== "closed") return existing;
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (key, kind, pr, head_ref, worktree_id, automation_id, terminal_handle, state, created_at, last_activity, notion_url, wo, title, repo_app, prompt_template)
     VALUES (?, 'task', NULL, ?, NULL, NULL, NULL, 'creating', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       pr = NULL,
       head_ref = excluded.head_ref,
       worktree_id = NULL,
       automation_id = NULL,
       terminal_handle = NULL,
       state = 'creating',
       last_activity = excluded.last_activity,
       notion_url = excluded.notion_url,
       title = excluded.title,
       repo_app = excluded.repo_app,
       prompt_template = excluded.prompt_template`,
  ).run(key, branch, now, now, notionUrl, wo, title, repoApp, promptTemplate);
  return getSession(db, key)!;
}

export function updateSession(db: DatabaseSync, key: string, fields: Partial<Session>): void {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => (fields as Record<string, SQLInputValue>)[c]);
  db.prepare(`UPDATE sessions SET ${setClause} WHERE key = ?`).run(...values, key);
}

export function touchSession(db: DatabaseSync, key: string): void {
  db.prepare("UPDATE sessions SET last_activity = ? WHERE key = ?").run(Date.now(), key);
}

// Soft-delete: state becomes 'closed', row stays around for history/debugging.
export function closeSessionRow(db: DatabaseSync, key: string): void {
  db.prepare("UPDATE sessions SET state = 'closed' WHERE key = ?").run(key);
}

// --- jobs -----------------------------------------------------------------

export function enqueueJob(
  db: DatabaseSync,
  sessionKey: string,
  commentId: number | null,
  author: string,
  prompt: string,
  kind: JobKind = null,
): { id: number; position: number } {
  const now = Date.now();
  db.prepare(
    "INSERT INTO jobs (session_key, kind, comment_id, author, prompt, state, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
  ).run(sessionKey, kind, commentId, author, prompt, now);
  const id = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  const position = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE session_key = ? AND state = 'queued' AND id <= ?")
        .get(sessionKey, id) as { n: number }
    ).n,
  );
  return { id, position };
}

// Atomically (single-threaded, no await in between) claim the oldest queued job for a session, but
// only if that session has no job already running — Orca forks a second agent session if two
// automation runs overlap on the same worktree, so this is a hard exclusion, not a rate limit.
export function claimNextJob(db: DatabaseSync, sessionKey: string): Job | undefined {
  const running = db.prepare("SELECT 1 FROM jobs WHERE session_key = ? AND state = 'running'").get(sessionKey);
  if (running) return undefined;
  const job = db
    .prepare("SELECT * FROM jobs WHERE session_key = ? AND state = 'queued' ORDER BY id ASC LIMIT 1")
    .get(sessionKey) as Job | undefined;
  if (!job) return undefined;
  db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
  return { ...job, state: "running" };
}

export function queuedSessionKeys(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT DISTINCT session_key FROM jobs WHERE state = 'queued'").all() as Array<{
    session_key: string;
  }>;
  return rows.map((r) => r.session_key);
}

export function setJobRunId(db: DatabaseSync, id: number, runId: string): void {
  db.prepare("UPDATE jobs SET run_id = ? WHERE id = ?").run(runId, id);
}

export function markJobDone(db: DatabaseSync, id: number, output: string): void {
  db.prepare("UPDATE jobs SET state = 'done', output = ?, finished_at = ? WHERE id = ?").run(output, Date.now(), id);
}

export function markJobFailed(db: DatabaseSync, id: number, error: string): void {
  db.prepare("UPDATE jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").run(error, Date.now(), id);
}

// When a session is closed (DELETE, /orca stop, idle sweep) its still-queued prompts must not
// run later against a resurrected session — fail them so the tick loop never claims them.
export function failQueuedJobs(db: DatabaseSync, sessionKey: string, error: string): void {
  db.prepare("UPDATE jobs SET state = 'failed', error = ?, finished_at = ? WHERE session_key = ? AND state = 'queued'").run(
    error,
    Date.now(),
    sessionKey,
  );
}

export function getQueue(db: DatabaseSync, sessionKey: string): Job[] {
  return db
    .prepare("SELECT * FROM jobs WHERE session_key = ? AND state IN ('queued','running') ORDER BY id ASC")
    .all(sessionKey) as unknown as Job[];
}

export function getLastOutput(db: DatabaseSync, sessionKey: string): string | null {
  const row = db
    .prepare("SELECT output FROM jobs WHERE session_key = ? AND state = 'done' ORDER BY id DESC LIMIT 1")
    .get(sessionKey) as { output: string } | undefined;
  return row?.output ?? null;
}

export function idleSessions(db: DatabaseSync, cutoff: number): string[] {
  const rows = db.prepare("SELECT key FROM sessions WHERE state = 'ready' AND last_activity < ?").all(cutoff) as Array<{
    key: string;
  }>;
  return rows.map((r) => r.key);
}
