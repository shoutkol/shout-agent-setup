import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openDb,
  ensurePrSession,
  ensureTaskSession,
  getSession,
  getSessionByPr,
  updateSession,
  enqueueJob,
  claimNextJob,
  markRunningJobsFailed,
  prKey,
  taskKey,
} from "../src/db.ts";

test("two queued jobs for one PR session: only one can be claimed as running", () => {
  const db = openDb(":memory:");
  ensurePrSession(db, 1, "feature-branch");
  enqueueJob(db, prKey(1), 100, "alice", "do the thing");
  enqueueJob(db, prKey(1), 101, "alice", "do another thing");

  const first = claimNextJob(db, prKey(1));
  assert.ok(first);
  assert.strictEqual(first?.state, "running");
  assert.strictEqual(first?.comment_id, 100); // oldest queued job first

  const second = claimNextJob(db, prKey(1));
  assert.strictEqual(second, undefined); // a job is already running for this session

  db.close();
});

test("two different PRs can each have a running job", () => {
  const db = openDb(":memory:");
  ensurePrSession(db, 1, "branch-a");
  ensurePrSession(db, 2, "branch-b");
  enqueueJob(db, prKey(1), 100, "alice", "a");
  enqueueJob(db, prKey(2), 200, "bob", "b");

  assert.ok(claimNextJob(db, prKey(1)));
  assert.ok(claimNextJob(db, prKey(2)));

  db.close();
});

test("restart marks a running job as failed, never resent", () => {
  const db = openDb(":memory:");
  ensurePrSession(db, 3, "feature-branch");
  enqueueJob(db, prKey(3), 300, "carol", "ship it");
  const job = claimNextJob(db, prKey(3));
  assert.ok(job);

  markRunningJobsFailed(db);

  const row = db.prepare("SELECT state, error FROM jobs WHERE id = ?").get(job!.id) as {
    state: string;
    error: string;
  };
  assert.strictEqual(row.state, "failed");
  assert.strictEqual(row.error, "wrapper restarted");

  db.close();
});

test("task session is keyed wo-<n>, kind 'task', pr starts null", () => {
  const db = openDb(":memory:");
  const session = ensureTaskSession(
    db,
    12,
    "https://notion.so/wo-12",
    "Campaign owner credit",
    "claude/WO-12-campaign-owner-credit",
    null,
    "Implement {{title}} on {{branch}}.",
  );
  assert.strictEqual(session.key, "wo-12");
  assert.strictEqual(session.kind, "task");
  assert.strictEqual(session.pr, null);
  assert.strictEqual(session.head_ref, "claude/WO-12-campaign-owner-credit");
  assert.strictEqual(session.notion_url, "https://notion.so/wo-12");
  assert.strictEqual(session.title, "Campaign owner credit");
  assert.strictEqual(session.wo, 12);
  assert.strictEqual(session.prompt_template, "Implement {{title}} on {{branch}}.");
  assert.strictEqual(getSession(db, taskKey(12))?.key, "wo-12");

  db.close();
});

test("getSessionByPr finds a task session once its pr column is set", () => {
  const db = openDb(":memory:");
  ensureTaskSession(db, 12, "https://notion.so/wo-12", "Campaign owner credit", "claude/WO-12-campaign-owner-credit", null, "go");
  assert.strictEqual(getSessionByPr(db, 427), undefined);

  updateSession(db, taskKey(12), { pr: 427 });

  const found = getSessionByPr(db, 427);
  assert.strictEqual(found?.key, "wo-12");
  assert.strictEqual(found?.kind, "task");

  db.close();
});

test("jobs are keyed by session_key: one running job per session, independent of kind", () => {
  const db = openDb(":memory:");
  ensureTaskSession(db, 5, "https://notion.so/wo-5", "Fix thing", "claude/WO-5-fix-thing", null, "go");
  enqueueJob(db, taskKey(5), null, "notion", "");
  enqueueJob(db, taskKey(5), null, "notion", "follow up");

  const first = claimNextJob(db, taskKey(5));
  assert.ok(first);
  assert.strictEqual(first?.session_key, "wo-5");
  assert.strictEqual(first?.comment_id, null);

  assert.strictEqual(claimNextJob(db, taskKey(5)), undefined); // one running job per session

  db.close();
});

test("ensurePrSession reuses the existing session for a PR that already has one (e.g. from a task)", () => {
  const db = openDb(":memory:");
  ensureTaskSession(db, 12, "https://notion.so/wo-12", "Campaign owner credit", "claude/WO-12-campaign-owner-credit", null, "go");
  updateSession(db, taskKey(12), { pr: 427 });

  const session = ensurePrSession(db, 427, "claude/WO-12-campaign-owner-credit");
  assert.strictEqual(session.key, "wo-12"); // reused, not a new pr-427 row
  assert.strictEqual(session.kind, "task");

  db.close();
});
