import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ensureSessionRow, enqueueJob, claimNextJob, markRunningJobsFailed } from "../src/db.ts";

test("two queued jobs for one PR: only one can be claimed as running", () => {
  const db = openDb(":memory:");
  ensureSessionRow(db, 1, "feature-branch");
  enqueueJob(db, 1, 100, "alice", "do the thing");
  enqueueJob(db, 1, 101, "alice", "do another thing");

  const first = claimNextJob(db, 1);
  assert.ok(first);
  assert.strictEqual(first?.state, "running");
  assert.strictEqual(first?.comment_id, 100); // oldest queued job first

  const second = claimNextJob(db, 1);
  assert.strictEqual(second, undefined); // a job is already running for this PR

  db.close();
});

test("two different PRs can each have a running job", () => {
  const db = openDb(":memory:");
  ensureSessionRow(db, 1, "branch-a");
  ensureSessionRow(db, 2, "branch-b");
  enqueueJob(db, 1, 100, "alice", "a");
  enqueueJob(db, 2, 200, "bob", "b");

  assert.ok(claimNextJob(db, 1));
  assert.ok(claimNextJob(db, 2));

  db.close();
});

test("restart marks a running job as failed, never resent", () => {
  const db = openDb(":memory:");
  ensureSessionRow(db, 3, "feature-branch");
  enqueueJob(db, 3, 300, "carol", "ship it");
  const job = claimNextJob(db, 3);
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
