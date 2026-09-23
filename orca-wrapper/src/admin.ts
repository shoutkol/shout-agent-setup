// Operator routes under /admin: see what's deployed, read the service log, and update/restart the
// service without a shell on the VM. Same bearer token as every other route.
//
// Restarting works by exiting non-zero: the systemd unit has `Restart=on-failure` (see
// ops/orca-wrapper.service), so systemd brings the process back up ~5 s later. A clean exit (0)
// would NOT be restarted — that's reserved for SIGTERM/SIGINT, i.e. `systemctl stop`.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import * as db from "./db.ts";
import * as orca from "./orca.ts";

const execFileAsync = promisify(execFile);

export const RESTART_EXIT_CODE = 75;
const MAX_LOG_LINES = 2000;
// The orca-wrapper/ directory; git finds the enclosing shout-agent-setup checkout from here.
const WRAPPER_DIR = fileURLToPath(new URL("..", import.meta.url));
const startedAt = Date.now();

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", WRAPPER_DIR, ...args], { timeout: 60_000 });
  return String(stdout).trim();
}

export async function health(handle: DatabaseSync): Promise<Record<string, unknown>> {
  const commit = await git("rev-parse", "--short", "HEAD").catch((err) => `unknown (${err?.message ?? err})`);
  let orcaStatus: string;
  try {
    await orca.repoPath(); // `orca repo list` — fails fast when the Orca app isn't running
    orcaStatus = "ok";
  } catch (err: any) {
    orcaStatus = err?.message ?? String(err);
  }
  return {
    commit,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    running_jobs: db.runningJobs(handle).length,
    queued_jobs: db.queuedJobCount(handle),
    orca: orcaStatus,
  };
}

export async function logs(lines: number): Promise<string> {
  const n = Math.min(Math.max(1, Math.floor(lines) || 200), MAX_LOG_LINES);
  const { stdout } = await execFileAsync(
    "journalctl",
    ["--user", "-u", "orca-wrapper", "-n", String(n), "--no-pager", "-o", "short-iso"],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return String(stdout);
}

export type RestartCheck = { ok: true } | { ok: false; running: Array<{ id: number; session_key: string }> };

// A restart marks every running job failed (db.markRunningJobsFailed), so refuse unless forced.
export function canRestart(handle: DatabaseSync, force: boolean): RestartCheck {
  const running = db.runningJobs(handle).map((j) => ({ id: j.id, session_key: j.session_key }));
  if (running.length > 0 && !force) return { ok: false, running };
  return { ok: true };
}

// Fast-forward to origin/main. Never merges or resets: a diverged or dirty checkout is an error
// for a human to look at, not something to paper over from an HTTP call.
export async function pullMain(): Promise<{ from: string; to: string }> {
  const from = await git("rev-parse", "--short", "HEAD");
  await git("fetch", "origin", "main");
  await git("merge", "--ff-only", "origin/main");
  const to = await git("rev-parse", "--short", "HEAD");
  return { from, to };
}
