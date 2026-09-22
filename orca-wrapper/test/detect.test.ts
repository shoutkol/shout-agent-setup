import { test } from "node:test";
import assert from "node:assert/strict";
import { isDone, stable } from "../src/logic.ts";

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
