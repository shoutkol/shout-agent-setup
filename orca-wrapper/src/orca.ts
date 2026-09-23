// Thin wrapper around the `orca` CLI (Orca 1.4.205). Every call shells out with `--json` and
// parses a uniform envelope: `{ok:true,result}` on success, `{ok:false,error:{code,message}}` on
// failure. We throw an Error carrying code+message for failures, except `terminal wait`, where
// `ok:false, error.code:'timeout'` is a normal "not idle yet" answer, not a failure.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.ts";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export class OrcaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OrcaError";
  }
}

// tolerateCode: if the command reports ok:false with this error code, return null instead of
// throwing — used only by terminalWaitIdle, where a timeout is an expected "still running" poll.
async function run(args: string[], tolerateCode?: string): Promise<any> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(config.orcaBin, [...args, "--json"], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    }));
  } catch (err: any) {
    // The CLI exits 1 on an ok:false answer (e.g. `terminal wait` timing out) while still
    // printing the JSON envelope on stdout, so execFile rejects. Fall through to the envelope
    // when there is one; only a missing/unparseable envelope is a real exec failure.
    if (typeof err?.stdout !== "string" || !err.stdout.trim().startsWith("{")) {
      const detail = String(err?.stderr ?? err?.message ?? err).trim().slice(0, 300);
      throw new OrcaError("exec", `orca ${args.slice(0, 2).join(" ")} failed: ${detail}`);
    }
    stdout = err.stdout;
  }
  const parsed = JSON.parse(String(stdout));
  if (!parsed.ok) {
    if (tolerateCode && parsed.error?.code === tolerateCode) return null;
    throw new OrcaError(parsed.error?.code ?? "unknown", parsed.error?.message ?? "orca command failed");
  }
  return parsed.result;
}

// Absolute path of the base checkout behind config.repoId (e.g. /home/dev/repo on the droplet).
// Looked up once: it is where `git fetch` must run before a worktree can be based on a branch.
let cachedRepoPath: string | undefined;
export async function repoPath(): Promise<string> {
  if (cachedRepoPath) return cachedRepoPath;
  const result = await run(["repo", "list"]);
  const repos: Array<{ id: string; path?: string; rootPath?: string }> = result.repos ?? result.repositories ?? result;
  const repo = repos.find((r) => r.id === config.repoId);
  const path = repo?.path ?? repo?.rootPath;
  if (!path) throw new OrcaError("repo_not_found", `repo ${config.repoId} not in orca repo list`);
  cachedRepoPath = path;
  return path;
}

// Always creates a NEW branch named `name` at baseBranch's current commit — it does not check
// out baseBranch itself (see the checkout dance in worker.ts's ensureWorktree). baseBranch is
// resolved by git in the base checkout, so it must already exist there as a local or
// remote-tracking ref ("origin/x" after a fetch is the safe form).
export async function worktreeCreate(name: string, baseBranch: string): Promise<string> {
  const result = await run([
    "worktree",
    "create",
    "--repo",
    `id:${config.repoId}`,
    "--name",
    name,
    "--no-parent",
    "--base-branch",
    baseBranch,
  ]);
  return result.worktree.id;
}

export async function worktreeList(): Promise<Array<{ id: string; branch: string }>> {
  const result = await run(["worktree", "list"]);
  return result.worktrees;
}

export async function worktreeRm(id: string): Promise<void> {
  await run(["worktree", "rm", "--worktree", `id:${id}`]);
}

export async function terminalCreate(worktreeId: string, title: string, command: string): Promise<string> {
  const result = await run(["terminal", "create", "--worktree", `id:${worktreeId}`, "--title", title, "--command", command]);
  return result.terminal.handle;
}

export async function terminalList(
  worktreeId: string,
): Promise<Array<{ handle: string; tabId: string; title: string }>> {
  const result = await run(["terminal", "list", "--worktree", `id:${worktreeId}`]);
  return result.terminals;
}

export async function terminalWaitIdle(handle: string, ms: number): Promise<boolean> {
  const result = await run(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", String(ms)], "timeout");
  if (result === null) return false; // ok:false / timeout — not idle yet, not an error
  return result.wait?.satisfied === true;
}

// True once the terminal's process has exited. A stale handle means the tab is already gone,
// which for a one-shot command terminal is the same thing as exited.
export async function terminalWaitExit(handle: string, ms: number): Promise<boolean> {
  try {
    const result = await run(["terminal", "wait", "--terminal", handle, "--for", "exit", "--timeout-ms", String(ms)], "timeout");
    if (result === null) return false;
    return result.wait?.satisfied === true;
  } catch (err) {
    if (err instanceof OrcaError && err.code === "terminal_handle_stale") return true;
    throw err;
  }
}

// Accumulated output lines (escape sequences stripped). Orca keeps only ~32 KB per terminal.
export async function terminalRead(handle: string, limit: number): Promise<string[]> {
  const result = await run(["terminal", "read", "--terminal", handle, "--limit", String(limit)]);
  return result.terminal?.tail ?? [];
}

export async function terminalClose(handle: string): Promise<void> {
  await run(["terminal", "close", "--terminal", handle]);
}

// A disabled daily schedule that we only ever fire manually via `automations run`.
export async function automationCreate(name: string, workspaceId: string, prompt: string): Promise<string> {
  const result = await run([
    "automations",
    "create",
    "--name",
    name,
    "--trigger",
    "daily",
    "--time",
    "03:00",
    "--prompt",
    prompt,
    "--provider",
    "claude",
    "--workspace",
    `id:${workspaceId}`,
    "--reuse-session",
    "--disabled",
  ]);
  return result.automation.id;
}

export async function automationEditPrompt(id: string, prompt: string): Promise<void> {
  await run(["automations", "edit", id, "--prompt", prompt]);
}

export async function automationRun(id: string): Promise<string> {
  const result = await run(["automations", "run", id]);
  return result.run.id;
}

export interface AutomationRun {
  id: string;
  runNumber: number;
  status: string;
  terminalSessionId: string | null;
  outputSnapshot: { content: string; capturedAt: string; truncated: boolean } | null;
  error: unknown;
}

export async function automationRuns(id: string): Promise<AutomationRun[]> {
  const result = await run(["automations", "runs", "--id", id]);
  return result.runs;
}

// Removing the automation does NOT close its live terminal — callers must terminalClose it too.
export async function automationRemove(id: string): Promise<void> {
  await run(["automations", "remove", id]);
}
