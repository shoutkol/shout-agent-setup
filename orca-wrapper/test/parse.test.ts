import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, isSafeRef, shq } from "../src/logic.ts";

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
