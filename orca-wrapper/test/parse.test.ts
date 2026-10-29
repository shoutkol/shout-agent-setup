import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, isSafeRef, shq, isReleaseNotesPrompt, acceptsOnClosedPr } from "../src/logic.ts";
import { mergedPreamble, PREAMBLE_MARKER } from "../src/preamble.ts";

test("/orca fix lint -> prompt", () => {
  assert.deepStrictEqual(parseCommand("/orca fix lint"), { type: "prompt", prompt: "fix lint" });
});

test("/orca   stop  -> stop", () => {
  assert.deepStrictEqual(parseCommand("/orca   stop "), { type: "stop" });
});

test("/orca STOP -> stop (case-insensitive)", () => {
  assert.deepStrictEqual(parseCommand("/orca STOP"), { type: "stop" });
});

test("/orcaX is rejected", () => {
  assert.strictEqual(parseCommand("/orcaX"), null);
});

test("hello /orca is rejected", () => {
  assert.strictEqual(parseCommand("hello /orca"), null);
});

test("bare /orca asks for the usage text", () => {
  assert.deepStrictEqual(parseCommand("/orca"), { type: "help" });
  assert.deepStrictEqual(parseCommand("  /orca  \n"), { type: "help" });
});

test("stop as people type it: punctuation and please -> stop", () => {
  for (const body of ["/orca stop.", "/orca Stop!", "/orca stop please", "/orca please stop", "/orca STOP!!"]) {
    assert.deepStrictEqual(parseCommand(body), { type: "stop" }, body);
  }
});

test("a longer sentence that starts with stop is a prompt, not a stop", () => {
  assert.deepStrictEqual(parseCommand("/orca stop the dev server and rerun the tests"), {
    type: "prompt",
    prompt: "stop the dev server and rerun the tests",
  });
});

const MARKER = "[orca-request kind=comment author=ziveso]";

test("a dev-stats marker before stop does not turn it into a prompt (PR 881)", () => {
  for (const body of [`/orca ${MARKER}\nstop`, `/orca ${MARKER} stop`, `/orca ${MARKER}\nStop!`, `/orca ${MARKER}\nplease stop`]) {
    assert.deepStrictEqual(parseCommand(body), { type: "stop" }, body);
  }
});

test("a marker with nothing after it is help", () => {
  assert.deepStrictEqual(parseCommand(`/orca ${MARKER}`), { type: "help" });
  assert.deepStrictEqual(parseCommand(`/orca ${MARKER}\n  \n`), { type: "help" });
});

test("a marker followed by a real prompt stays a prompt and keeps the marker", () => {
  assert.deepStrictEqual(parseCommand(`/orca ${MARKER}\nfix lint`), { type: "prompt", prompt: `${MARKER}\nfix lint` });
  assert.deepStrictEqual(parseCommand(`/orca ${MARKER}\nstop the dev server and rerun the tests`), {
    type: "prompt",
    prompt: `${MARKER}\nstop the dev server and rerun the tests`,
  });
});

test("a malformed marker is not skipped", () => {
  assert.deepStrictEqual(parseCommand("/orca [orca-request kind=x\nstop"), { type: "prompt", prompt: "[orca-request kind=x\nstop" });
  assert.deepStrictEqual(parseCommand(`/orca ${MARKER}stop`), { type: "prompt", prompt: `${MARKER}stop` });
});

test("isSafeRef: real branch names pass", () => {
  for (const ref of ["dev", "claude/WO-74-test-orca-e2e-qa-ignore", "feat/kol-tag-discovery-phase2", "qa/orca-e2e-plain", "v1.2_fix"]) {
    assert.strictEqual(isSafeRef(ref), true, ref);
  }
});

test("isSafeRef: shell metacharacters and git-invalid forms are refused", () => {
  for (const ref of ["t;touch${IFS}/tmp/pwned", "x$(id)", "a b", "-rf", "/abs", "trail/", "a..b", "a//b", "x.lock", "a`id`", "a|b", "a'b"]) {
    assert.strictEqual(isSafeRef(ref), false, ref);
  }
});

test("shq single-quotes for a POSIX shell, including embedded quotes", () => {
  assert.strictEqual(shq("feat/x"), "'feat/x'");
  assert.strictEqual(shq("it's"), "'it'\\''s'");
});

test("isReleaseNotesPrompt: `/release-notes <this pr>` with optional `final`, marker or not", () => {
  const marker = "[orca-request kind=release author=github-actions]";
  assert.equal(isReleaseNotesPrompt("/release-notes 1207", 1207), true);
  assert.equal(isReleaseNotesPrompt("/release-notes 1207 final", 1207), true);
  assert.equal(isReleaseNotesPrompt(`${marker}\n/release-notes 1207`, 1207), true);
  assert.equal(isReleaseNotesPrompt(`${marker}\n/release-notes 1207 final`, 1207), true);
  assert.equal(isReleaseNotesPrompt("/release-notes 1208", 1207), false); // another PR's number
  assert.equal(isReleaseNotesPrompt("/release-notes 1207 now", 1207), false);
  assert.equal(isReleaseNotesPrompt("/release-notes", 1207), false);
  assert.equal(isReleaseNotesPrompt("/release-notes 1207\nand also fix the typo", 1207), false);
  assert.equal(isReleaseNotesPrompt("summarise /release-notes 1207", 1207), false);
});

test("acceptsOnClosedPr: only a release-notes prompt on a PR merged into main", () => {
  const p = "/release-notes 5";
  assert.equal(acceptsOnClosedPr({ state: "closed", merged: true, baseRef: "main" }, p, 5), true);
  assert.equal(acceptsOnClosedPr({ state: "closed", merged: true, baseRef: "main" }, "fix it", 5), false);
  assert.equal(acceptsOnClosedPr({ state: "closed", merged: false, baseRef: "main" }, p, 5), false);
  assert.equal(acceptsOnClosedPr({ state: "closed", merged: true, baseRef: "dev" }, p, 5), false);
});

test("mergedPreamble starts with the preamble marker and never tells the agent to push", () => {
  const text = mergedPreamble(1207);
  assert.ok(text.startsWith(PREAMBLE_MARKER));
  assert.doesNotMatch(text, /git push/);
});
