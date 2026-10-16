import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentExited } from "../src/logic.ts";

// PR 881: Claude quit in the session's terminal, the job failed with terminal_exited, and the row
// kept its automation_id and terminal_handle, so every later job waited busyWaitMin on a bare
// shell. The failed job must reset the agent (and only the agent: the worktree stays).
const orcaLog = join(mkdtempSync(join(tmpdir(), "orca-exited-")), "calls.log");
process.env.ORCA_WRAPPER_TOKEN = "t";
process.env.ORCA_REPO_ID = "r";
process.env.GITHUB_DRY_RUN = "1";
process.env.GITHUB_TOKEN = "x";
process.env.DB_PATH = ":memory:";
process.env.ORCA_BIN = fileURLToPath(new URL("./fixtures/fake-orca-exited.sh", import.meta.url));
process.env.FAKE_ORCA_LOG = orcaLog;

const db = await import("../src/db.ts");
const { createWorker } = await import("../src/worker.ts");

test("agentExited matches the terminal_exited reason only", () => {
  assert.strictEqual(agentExited("terminal_exited"), true);
  assert.strictEqual(agentExited("run failed: terminal_exited (code 0)"), true);
  assert.strictEqual(agentExited("timed out after 60 minutes"), false);
  assert.strictEqual(agentExited("run failed"), false);
});

test("a job that ends terminal_exited clears the session's agent and keeps its worktree", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    const handle = db.openDb(":memory:");
    const worker = createWorker(handle);
    const key = db.taskKey(881);
    // A session that already has a worktree and a live agent, as after a first successful job.
    db.ensureTaskSession(handle, 881, "https://app.notion.com/p/x", "t", "claude/WO-881-t", null, "do it");
    db.updateSession(handle, key, { state: "ready", worktree_id: "wt1", automation_id: "auto1", terminal_handle: "th1", pr: 881 });
    db.enqueueJob(handle, key, null, "guy", "do it");
    worker.tick();
    const job = () => handle.prepare("SELECT state, error FROM jobs WHERE session_key = ?").get(key) as { state: string; error: string | null };
    const deadline = Date.now() + 15_000;
    while (job()?.state !== "failed" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(job().state, "failed");
    assert.strictEqual(job().error, "terminal_exited");
    const session = db.getSession(handle, key)!;
    assert.strictEqual(session.automation_id, null);
    assert.strictEqual(session.terminal_handle, null);
    assert.ok(session.worktree_id, "the worktree must survive: it may hold unpushed work");
    assert.match(readFileSync(orcaLog, "utf8"), /automations remove /);
  } finally {
    console.log = log;
  }
});
