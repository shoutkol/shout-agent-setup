// Centralised env parsing — read once at process startup, everything else imports `config`.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const home = process.env.HOME ?? "";
const githubDryRun = process.env.GITHUB_DRY_RUN === "1";

// GITHUB_TOKEN: use the env var if set, otherwise shell out to `gh auth token` once at startup.
// Skipped in dry-run when unset, since GITHUB_DRY_RUN exists precisely so local smoke tests
// don't need a real `gh` login.
async function resolveGithubToken(): Promise<string> {
  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  if (githubDryRun) return "dry-run";
  const { stdout } = await execFileAsync("gh", ["auth", "token"]);
  return String(stdout).trim();
}

const dbPath = process.env.DB_PATH ?? `${home}/.local/share/orca-wrapper/state.sqlite`;
// ":memory:" (used by tests) has no directory component worth creating; dirname(".") is a no-op.
mkdirSync(dirname(dbPath), { recursive: true });

export const config = {
  token: required("ORCA_WRAPPER_TOKEN"),
  orcaBin: process.env.ORCA_BIN ?? `${home}/.local/bin/orca`,
  repoId: required("ORCA_REPO_ID"),
  githubRepo: process.env.GITHUB_REPO ?? "shoutkol/shout",
  githubToken: await resolveGithubToken(),
  githubDryRun,
  port: Number(process.env.PORT ?? 8787),
  dbPath,
  idleDays: Number(process.env.IDLE_DAYS ?? 15),
  runTimeoutMin: Number(process.env.RUN_TIMEOUT_MIN ?? 60),
  busyWaitMin: Number(process.env.BUSY_WAIT_MIN ?? 10),
};
