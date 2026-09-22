import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/logic.ts";

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

test("bare /orca with nothing after is rejected", () => {
  assert.strictEqual(parseCommand("/orca"), null);
});
