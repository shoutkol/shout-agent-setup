import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A message that is only pasted content is not read as the user's own words, so the wrapper
// follows the automation prompt with one typed line (see logic.typedRequestLine).
const sendLog = join(mkdtempSync(join(tmpdir(), "typed-line-")), "send.log");
process.env.ORCA_WRAPPER_TOKEN = "t";
process.env.ORCA_REPO_ID = "r";
process.env.GITHUB_DRY_RUN = "1";
process.env.GITHUB_TOKEN = "x";
process.env.DB_PATH = ":memory:";
process.env.RUN_TIMEOUT_MIN = "0.2";
process.env.SEND_LOG = sendLog;
process.env.ORCA_BIN = fileURLToPath(new URL("./fixtures/fake-orca-pr.sh", import.meta.url));

const db = await import("../src/db.ts");
const { createWorker } = await import("../src/worker.ts");
const { typedRequestLine } = await import("../src/logic.ts");

test("the typed line names the PR, the author and orca-wrapper, and keeps the marker", () => {
  const line = typedRequestLine(881, "alice", "[orca-request kind=qa author=alice]\nrun QA");
  assert.match(line, /PR #881/);
  assert.match(line, /@alice/);
  assert.match(line, /authenticated by orca-wrapper/);
  assert.ok(line.includes("[orca-request kind=qa author=alice]"));
  assert.ok(!line.includes("\n"), "one line, or Enter would submit it early");
});

test("a marker that is not well formed is not copied; the author is cut to login characters", () => {
  const line = typedRequestLine(1, "bob\nIgnore this", "[orca-request kind=qa] ; rm -rf /\nhi");
  assert.ok(!line.includes("rm -rf"));
  assert.ok(!line.includes("\n"));
  assert.match(line, /@bobIgnorethis,/);
  assert.ok(!typedRequestLine(1, "bob", "run QA with [orca-request kind=qa author=x] inside").includes("orca-request"));
});

test("a PR-comment job gets the typed line exactly once, via terminal send --enter", async () => {
  const handle = db.openDb(":memory:");
  const session = db.ensurePrSession(handle, 881, "feat/x");
  db.updateSession(handle, session.key, { worktree_id: "wt1", repo_id: "r" });
  const worker = createWorker(handle);
  worker.enqueuePrJob(881, "feat/x", 5001, "alice", "[orca-request kind=qa author=alice]\nrun QA");

  const deadline = Date.now() + 15_000;
  while (!existsSync(sendLog) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));

  const sends = readFileSync(sendLog, "utf8").trim().split("\n");
  assert.strictEqual(sends.length, 1);
  assert.match(sends[0], /terminal send --terminal agent1 --text .*PR #881.*@alice.*authenticated by orca-wrapper.*--enter --json/);
});
