import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The real CLI exits 1 when it answers ok:false (seen live: `terminal wait` timing out killed a
// job with "Command failed: ... orca terminal wait ..."). The fake below reproduces exactly that.
process.env.ORCA_WRAPPER_TOKEN = "t";
process.env.ORCA_REPO_ID = "r";
process.env.GITHUB_DRY_RUN = "1";
process.env.GITHUB_TOKEN = "x";
process.env.DB_PATH = ":memory:";
process.env.ORCA_BIN = fileURLToPath(new URL("./fixtures/fake-orca.sh", import.meta.url));

const orca = await import("../src/orca.ts");

test("terminal wait timeout (ok:false + exit 1) means 'not idle', not a crash", async () => {
  assert.strictEqual(await orca.terminalWaitIdle("term_x", 100), false);
});

test("other ok:false answers with exit 1 surface as OrcaError with the CLI's code", async () => {
  await assert.rejects(orca.terminalClose("term_x"), (err: any) => err instanceof orca.OrcaError && err.code === "not_found");
});

test("ok:true answers still parse normally", async () => {
  assert.deepStrictEqual(await orca.terminalList("w"), []);
});

test("repoPath resolves a repo id's base checkout from repo list", async () => {
  assert.strictEqual(await orca.repoPath("r"), "/srv/base");
  await assert.rejects(orca.repoPath("nope"), (err: any) => err.code === "repo_not_found");
});

test("repoHosts maps each repo id to its execution host", async () => {
  assert.deepStrictEqual([...(await orca.repoHosts())], [["r", "ssh:ssh-1"], ["r2", "ssh:ssh-2"]]);
});

// `host list` ids have no "ssh:" prefix; hostsConnected adds it so they match repoHosts' values.
test("hostsConnected returns only connected hosts, in repoHosts' id form", async () => {
  assert.deepStrictEqual([...(await orca.hostsConnected())].sort(), ["local", "ssh:ssh-1"]);
});

test("worktreeCountsByRepo counts every worktree per repo id", async () => {
  assert.deepStrictEqual([...(await orca.worktreeCountsByRepo())], [["r", 2], ["r2", 1]]);
});
