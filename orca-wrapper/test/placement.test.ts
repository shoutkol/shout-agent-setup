import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRepo } from "../src/logic.ts";

// Two droplets registered as SSH targets: the same repo is two Orca repo ids, one per host.
const hostOf = new Map([
  ["a", "ssh:host-a"],
  ["b", "ssh:host-b"],
]);
const both = new Set(["ssh:host-a", "ssh:host-b"]);

test("the repo with the fewest worktrees wins", () => {
  assert.strictEqual(pickRepo(["a", "b"], both, hostOf, new Map([["a", 5], ["b", 2]])), "b");
  assert.strictEqual(pickRepo(["a", "b"], both, hostOf, new Map([["a", 1], ["b", 2]])), "a");
});

test("a repo with no worktrees at all counts as zero", () => {
  assert.strictEqual(pickRepo(["a", "b"], both, hostOf, new Map([["a", 3]])), "b");
});

test("a disconnected host is skipped even when it has fewer worktrees", () => {
  const onlyB = new Set(["ssh:host-b"]);
  assert.strictEqual(pickRepo(["a", "b"], onlyB, hostOf, new Map([["a", 0], ["b", 9]])), "b");
});

test("null when no configured host is connected", () => {
  assert.strictEqual(pickRepo(["a", "b"], new Set(), hostOf, new Map()), null);
});

test("ties go to the first configured id", () => {
  assert.strictEqual(pickRepo(["a", "b"], both, hostOf, new Map([["a", 2], ["b", 2]])), "a");
  assert.strictEqual(pickRepo(["b", "a"], both, hostOf, new Map([["a", 2], ["b", 2]])), "b");
});

test("ids Orca does not know are ignored, and a single configured host behaves as before", () => {
  assert.strictEqual(pickRepo(["ghost", "b"], both, hostOf, new Map()), "b");
  assert.strictEqual(pickRepo(["ghost"], both, hostOf, new Map()), null);
  assert.strictEqual(pickRepo(["a"], both, hostOf, new Map([["a", 40]])), "a");
});
