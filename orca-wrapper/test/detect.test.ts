import { test } from "node:test";
import assert from "node:assert/strict";
import { isDone, isLaunchFrame, stable } from "../src/logic.ts";

test("fresh session: early completed but not idle -> pending", () => {
  assert.strictEqual(isDone("completed", false), "pending");
});

test("reused session: dispatched but idle -> pending", () => {
  assert.strictEqual(isDone("dispatched", true), "pending");
});

test("completed and idle -> done", () => {
  assert.strictEqual(isDone("completed", true), "done");
});

test("failed run -> error, regardless of idle", () => {
  assert.strictEqual(isDone("failed", true), "error");
  assert.strictEqual(isDone("cancelled", false), "error");
});

test("stable: two identical non-null readings in a row settle", () => {
  assert.strictEqual(stable(["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"]), "2024-01-01T00:00:00Z");
});

test("stable: a single reading, or two differing ones, are not settled yet", () => {
  assert.strictEqual(stable(["a"]), undefined);
  assert.strictEqual(stable(["a", "b"]), undefined);
});

test("stable: null readings never settle", () => {
  assert.strictEqual(stable([null, null]), undefined);
});

test("stable: settles on the first repeated pair further down the sequence", () => {
  assert.strictEqual(stable(["a", "b", "b"]), "b");
});

// The frame that got posted to PR 482 verbatim — Orca's pre-TUI capture of a fresh session.
const MARKER = "You are working in a git worktree checked out on branch";
const PR482_FRAME = `To run a command as administrator (user "root"), use "sudo <command>".
See "man sudo_root" for details.

dev@orca-remote-ssh-00:~/repo-pr-482$ claude '--dangerously-skip-permissions' 'You are working in a git worktree checked out on branch \`feat/recruiter-monitor-redesign\` of shoutkol/shout, which is the head branch of PR #482. Run \`git pull --ff-only\` first.

/code-review'`;

test("launch frame: the PR 482 pre-TUI capture is not an answer", () => {
  assert.strictEqual(isLaunchFrame(PR482_FRAME, MARKER), true);
});

test("launch frame: a bare shell prompt or empty capture is not an answer", () => {
  assert.strictEqual(isLaunchFrame("dev@orca-remote-ssh-00:~/repo-pr-482$", MARKER), true);
  assert.strictEqual(isLaunchFrame("stickleback on  ziveso/stickleback [?] via  v22.22.1 on ☁️  $ ", MARKER), true);
  assert.strictEqual(isLaunchFrame("   ", MARKER), true);
});

test("launch frame: real answers pass, even short ones or ones mentioning branches", () => {
  assert.strictEqual(isLaunchFrame("OK", MARKER), false);
  assert.strictEqual(isLaunchFrame("PINEAPPLE", MARKER), false);
  assert.strictEqual(
    isLaunchFrame("Reviewed feat/recruiter-monitor-redesign: 5 findings.\n\nQUESTION: land the cohort rewiring here or in a follow-up PR?", MARKER),
    false,
  );
  assert.strictEqual(isLaunchFrame("Costs are in USD ($) — see the $ column.", MARKER), false);
});
