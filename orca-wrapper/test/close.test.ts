import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Closing sessions: the sweep's closed-PR pass and the save-before-remove step in teardown. GitHub
// is real-mode with a stubbed fetch (dry-run always reports PRs open); orca is a fake that logs
// each call to FAKE_ORCA_LOG.
const fakeOrca = fileURLToPath(new URL("./fixtures/fake-orca-teardown.sh", import.meta.url));
const orcaLog = join(mkdtempSync(join(tmpdir(), "orca-close-")), "calls.log");
process.env.ORCA_WRAPPER_TOKEN = "t";
process.env.ORCA_REPO_ID = "r";
process.env.GITHUB_TOKEN = "x";
process.env.DB_PATH = ":memory:";
process.env.ORCA_BIN = fakeOrca;
process.env.FAKE_ORCA_LOG = orcaLog;

const db = await import("../src/db.ts");
const { createWorker } = await import("../src/worker.ts");

function openSession(handle: ReturnType<typeof db.openDb>, pr: number, worktreeId: string | null): string {
  const session = db.ensurePrSession(handle, pr, `head-${pr}`);
  db.updateSession(handle, session.key, { state: "ready", worktree_id: worktreeId });
  return session.key;
}

test("sweepIdle closes an open session whose PR is closed on GitHub and leaves one whose PR is open", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    new Response(JSON.stringify({ state: String(url).endsWith("/pulls/649") ? "closed" : "open" }))) as typeof fetch;
  try {
    const handle = db.openDb(":memory:");
    const closedKey = openSession(handle, 649, null);
    const openKey = openSession(handle, 650, null);
    await createWorker(handle).sweepIdle();
    assert.strictEqual(db.getSession(handle, closedKey)?.state, "closed");
    assert.strictEqual(db.getSession(handle, openKey)?.state, "ready");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("teardown saves unsaved work first, and keeps the worktree when the save does not finish", async () => {
  const calls = () => readFileSync(orcaLog, "utf8");
  const realNow = Date.now;
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    // Saved (or nothing to save): the save command is sent to the worktree, then it is removed.
    const handle = db.openDb(":memory:");
    const savedKey = openSession(handle, 651, "wt-saved");
    await createWorker(handle).closeSession(savedKey);
    assert.match(calls(), /--command if \[ -n .*orca-wip\/pr-651/);
    assert.match(calls(), /worktree rm --worktree id:wt-saved/);
    // repo_id is NULL on this row (created before multi-host): the branch cleanup runs in the first configured id's base checkout.
    assert.match(calls(), /terminal create --worktree id:r::\/srv\/base --title cleanup/);
    assert.strictEqual(db.getSession(handle, savedKey)?.state, "closed");

    // The shell never exits: not saved, so no worktree rm. Fast-forward the clock past the
    // wait's one-minute deadline instead of sitting through it.
    process.env.FAKE_ORCA_HANG = "1";
    let t = realNow();
    Date.now = () => (t += 30_000);
    const keptKey = openSession(handle, 652, "wt-kept");
    await createWorker(handle).closeSession(keptKey);
    assert.doesNotMatch(calls(), /worktree rm --worktree id:wt-kept/);
    assert.ok(logs.some((l) => l.includes("keeping worktree key=pr-652")), `log:\n${logs.join("\n")}`);
  } finally {
    Date.now = realNow;
    console.log = log;
    delete process.env.FAKE_ORCA_HANG;
  }
});
