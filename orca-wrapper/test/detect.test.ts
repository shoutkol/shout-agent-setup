import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundVerdict, isDone, isLaunchFrame, launchMarker, stable } from "../src/logic.ts";
import { readFileSync } from "node:fs";

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

test("launch frame: our prompt echoed back at the top (or as a > quote) is not an answer", () => {
  assert.strictEqual(isLaunchFrame(`${MARKER} \`feat/x\` of shoutkol/shout …`, MARKER), true);
  assert.strictEqual(isLaunchFrame(`> ${MARKER} \`feat/x\``, MARKER), true);
});

test("launch frame: answers that only look like one pass (H-07)", () => {
  assert.strictEqual(isLaunchFrame("ราคา 5$", MARKER), false);
  assert.strictEqual(isLaunchFrame("ค่าใช้จ่ายรวม 12$", MARKER), false);
  assert.strictEqual(isLaunchFrame("The agent runs as `claude --dangerously-skip-permissions`, so it never asks.", MARKER), false);
  assert.strictEqual(isLaunchFrame(`The preamble says: "${MARKER} \`feat/x\`…" — that's why I pulled first.`, MARKER), false);
});

test("launch frame: a short task prompt gives no marker, so answers containing it pass (H-06)", () => {
  for (const prompt of ["ok", "yes", "token", "ช่วยดูหน่อย"]) {
    assert.strictEqual(launchMarker(prompt), "", prompt);
  }
  assert.strictEqual(isLaunchFrame("Looks fine to me — the token refresh is ok.", launchMarker("ok")), false);
  assert.strictEqual(isLaunchFrame('"token" หมายถึงเรื่องไหนครับ', launchMarker("token")), false);
  const long = "You are working in a git worktree checked out on branch `claude/WO-74-x`";
  assert.strictEqual(launchMarker(long), long.slice(0, 40));
});

test("launch frame: a raw TUI screen (PR 492, agent still in its Stop hook) is not an answer", () => {
  const frame = readFileSync(new URL("./fixtures/tui-frame-pr492.txt", import.meta.url), "utf8");
  assert.strictEqual(isLaunchFrame(frame, "You are working in a git worktree of shoutkol/shout"), true);
  assert.strictEqual(isLaunchFrame(frame, ""), true); // even with no marker (short task prompt)
});

test("launch frame: answers using ordinary bullets, arrows or 'for 5s' still pass", () => {
  for (const answer of [
    "- item one\n- item two",
    "* bold point\n* another",
    "Timings: build ran for 17s, tests for 42s.",
    "HEAD -> qa/orca-e2e-plain (75545a8d5..b46822f07)",
    "สรุป:\n• แก้ 2 ไฟล์\n• push แล้ว",
  ]) {
    assert.strictEqual(isLaunchFrame(answer, MARKER), false, answer);
  }
});

test("backgroundVerdict: a turn that left sub-agents running is not the answer (PR 491)", () => {
  assert.strictEqual(backgroundVerdict({ pending: 2, background: true, answer: "Both reviewers are running." }), "wait");
  assert.strictEqual(backgroundVerdict({ pending: 1, background: true, answer: "Spec done, waiting for Standards." }), "wait");
});

test("backgroundVerdict: once sub-agents are done, the transcript's answer beats a lagging snapshot", () => {
  assert.strictEqual(backgroundVerdict({ pending: 0, background: true, answer: "## Code review\n\n…" }), "transcript");
  // …unless the transcript has no text to offer
  assert.strictEqual(backgroundVerdict({ pending: 0, background: true, answer: "  " }), "snapshot");
});

test("backgroundVerdict: no sub-agents, or an unreadable transcript -> the snapshot, as before", () => {
  assert.strictEqual(backgroundVerdict({ pending: 0, background: false, answer: "done" }), "snapshot");
  assert.strictEqual(backgroundVerdict(null), "snapshot");
});
