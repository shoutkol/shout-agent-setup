// SQLite state, in plain functions over a shared DatabaseSync handle (no ORM, no query builder —
// the schema is two small tables). Callers pass the handle in so tests can use ":memory:".
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SessionState = "creating" | "ready" | "closing" | "closed";
export type JobState = "queued" | "running" | "done" | "failed";

export interface Session {
  pr: number;
  head_ref: string;
  worktree_id: string | null;
  automation_id: string | null;
  terminal_handle: string | null;
  state: SessionState;
  created_at: number;
  last_activity: number;
}

export interface Job {
  id: number;
  pr: number;
  comment_id: number;
  author: string;
  prompt: string;
  state: JobState;
  run_id: string | null;
  output: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;"); // no-op (falls back to 'memory') for :memory: databases
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      pr INTEGER PRIMARY KEY,
      head_ref TEXT NOT NULL,
      worktree_id TEXT,
      automation_id TEXT,
      terminal_handle TEXT,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr INTEGER NOT NULL,
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

export function getSession(db: DatabaseSync, pr: number): Session | undefined {
  return db.prepare("SELECT * FROM sessions WHERE pr = ?").get(pr) as Session | undefined;
}

export function listOpenSessions(db: DatabaseSync): Session[] {
  return db.prepare("SELECT * FROM sessions WHERE state != 'closed'").all() as unknown as Session[];
}

// Called when a prompt comes in for a PR. If there's no live (non-closed) session row yet, create
// one carrying head_ref — the worker needs head_ref to create the worktree later, and by the time
// it runs, the original HTTP request (which is the only place head_ref appears) is long gone.
export function ensureSessionRow(db: DatabaseSync, pr: number, headRef: string): void {
  const existing = getSession(db, pr);
  if (existing && existing.state !== "closed") {
    if (existing.head_ref !== headRef) {
      db.prepare("UPDATE sessions SET head_ref = ? WHERE pr = ?").run(headRef, pr);
    }
    return;
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (pr, head_ref, worktree_id, automation_id, terminal_handle, state, created_at, last_activity)
     VALUES (?, ?, NULL, NULL, NULL, 'creating', ?, ?)
     ON CONFLICT(pr) DO UPDATE SET
       head_ref = excluded.head_ref,
       worktree_id = NULL,
       automation_id = NULL,
       terminal_handle = NULL,
       state = 'creating',
       last_activity = excluded.last_activity`,
  ).run(pr, headRef, now, now);
}

export function updateSession(db: DatabaseSync, pr: number, fields: Partial<Session>): void {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => (fields as Record<string, SQLInputValue>)[c]);
  db.prepare(`UPDATE sessions SET ${setClause} WHERE pr = ?`).run(...values, pr);
}

export function touchSession(db: DatabaseSync, pr: number): void {
  db.prepare("UPDATE sessions SET last_activity = ? WHERE pr = ?").run(Date.now(), pr);
}

// Soft-delete: state becomes 'closed', row stays around for history/debugging.
export function closeSessionRow(db: DatabaseSync, pr: number): void {
  db.prepare("UPDATE sessions SET state = 'closed' WHERE pr = ?").run(pr);
}

// --- jobs -----------------------------------------------------------------

export function enqueueJob(
  db: DatabaseSync,
  pr: number,
  commentId: number,
  author: string,
  prompt: string,
): { id: number; position: number } {
  const now = Date.now();
  db.prepare(
    "INSERT INTO jobs (pr, comment_id, author, prompt, state, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
  ).run(pr, commentId, author, prompt, now);
  const id = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  const position = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE pr = ? AND state = 'queued' AND id <= ?")
        .get(pr, id) as { n: number }
    ).n,
  );
  return { id, position };
}

// Atomically (single-threaded, no await in between) claim the oldest queued job for a PR, but
// only if that PR has no job already running — Orca forks a second agent session if two
// automation runs overlap on the same worktree, so this is a hard exclusion, not a rate limit.
export function claimNextJob(db: DatabaseSync, pr: number): Job | undefined {
  const running = db.prepare("SELECT 1 FROM jobs WHERE pr = ? AND state = 'running'").get(pr);
  if (running) return undefined;
  const job = db.prepare("SELECT * FROM jobs WHERE pr = ? AND state = 'queued' ORDER BY id ASC LIMIT 1").get(pr) as
    | Job
    | undefined;
  if (!job) return undefined;
  db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
  return { ...job, state: "running" };
}

export function queuedPrs(db: DatabaseSync): number[] {
  const rows = db.prepare("SELECT DISTINCT pr FROM jobs WHERE state = 'queued'").all() as Array<{ pr: number }>;
  return rows.map((r) => r.pr);
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
export function failQueuedJobs(db: DatabaseSync, pr: number, error: string): void {
  db.prepare("UPDATE jobs SET state = 'failed', error = ?, finished_at = ? WHERE pr = ? AND state = 'queued'").run(
    error,
    Date.now(),
    pr,
  );
}

export function getQueue(db: DatabaseSync, pr: number): Job[] {
  return db.prepare("SELECT * FROM jobs WHERE pr = ? AND state IN ('queued','running') ORDER BY id ASC").all(
    pr,
  ) as unknown as Job[];
}

export function getLastOutput(db: DatabaseSync, pr: number): string | null {
  const row = db
    .prepare("SELECT output FROM jobs WHERE pr = ? AND state = 'done' ORDER BY id DESC LIMIT 1")
    .get(pr) as { output: string } | undefined;
  return row?.output ?? null;
}

export function idleSessions(db: DatabaseSync, cutoff: number): number[] {
  const rows = db.prepare("SELECT pr FROM sessions WHERE state = 'ready' AND last_activity < ?").all(
    cutoff,
  ) as Array<{ pr: number }>;
  return rows.map((r) => r.pr);
}
