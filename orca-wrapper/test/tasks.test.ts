import { test } from "node:test";
import assert from "node:assert/strict";
import { branchFor, isNotionUrl } from "../src/logic.ts";

test("branchFor: normal title -> claude/WO-<n>-<slug>", () => {
  assert.strictEqual(branchFor(12, "Campaign owner credit"), "claude/WO-12-campaign-owner-credit");
});

test("branchFor: a title with nothing sluggable (e.g. all-Thai) falls back to just the WO number", () => {
  assert.strictEqual(branchFor(7, "แคมเปญเจ้าของเครดิต"), "claude/WO-7");
});

test("branchFor: symbols are stripped, not turned into dashes; runs of whitespace collapse to one dash", () => {
  assert.strictEqual(branchFor(9, "Fix bug!! (urgent) -- now"), "claude/WO-9-fix-bug-urgent-now");
});

test("branchFor: slug is capped at 40 chars, and a cut that lands on a dash doesn't leave one dangling", () => {
  const branch = branchFor(3, "a".repeat(60));
  assert.strictEqual(branch, `claude/WO-3-${"a".repeat(40)}`);

  const trailingDash = branchFor(4, "a".repeat(39) + " bbbb"); // the 40-char cut lands exactly on the dash
  assert.strictEqual(trailingDash, `claude/WO-4-${"a".repeat(39)}`);
});

test("isNotionUrl: accepts an https URL that mentions notion", () => {
  assert.strictEqual(isNotionUrl("https://www.notion.so/Campaign-owner-credit-abc123"), true);
  assert.strictEqual(isNotionUrl("https://notion.so/abc123"), true);
});

test("isNotionUrl: rejects non-https and non-Notion URLs", () => {
  assert.strictEqual(isNotionUrl("http://notion.so/abc123"), false);
  assert.strictEqual(isNotionUrl("https://example.com/abc123"), false);
  assert.strictEqual(isNotionUrl("not a url"), false);
});
