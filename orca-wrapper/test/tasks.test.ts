import { test } from "node:test";
import assert from "node:assert/strict";
import { branchFor, isNotionUrl, renderPrompt } from "../src/logic.ts";

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

test("renderPrompt: replaces every known placeholder with the session's values", () => {
  const out = renderPrompt("Branch {{branch}} for WO-{{wo}}: {{title}}. Spec: {{notion_url}}", {
    branch: "claude/WO-12-campaign-owner-credit",
    wo: "12",
    title: "Campaign owner credit",
    notion_url: "https://notion.so/wo-12",
    repo_app: "",
  });
  assert.strictEqual(
    out,
    "Branch claude/WO-12-campaign-owner-credit for WO-12: Campaign owner credit. Spec: https://notion.so/wo-12",
  );
});

test("renderPrompt: repo_app is comma-joined, or blank when there is none", () => {
  const vars = { branch: "", wo: "", title: "", notion_url: "", repo_app: "" };
  assert.strictEqual(renderPrompt("apps: {{repo_app}}.", vars), "apps: .");
  assert.strictEqual(renderPrompt("apps: {{repo_app}}.", { ...vars, repo_app: "shout-web, shout-ai" }), "apps: shout-web, shout-ai.");
});

test("renderPrompt: an unrecognised placeholder is left untouched, not blanked", () => {
  const vars = { branch: "b", wo: "1", title: "t", notion_url: "n", repo_app: "" };
  assert.strictEqual(renderPrompt("Hello {{nickname}}!", vars), "Hello {{nickname}}!");
});

test("renderPrompt: a template with no placeholders is returned unchanged", () => {
  assert.strictEqual(renderPrompt("Just read the ticket and go.", {}), "Just read the ticket and go.");
});

test("renderPrompt: placeholders only match the vars' own keys, never Object.prototype's", () => {
  const vars = { branch: "b", wo: "1", title: "t", notion_url: "n", repo_app: "" };
  assert.strictEqual(
    renderPrompt("{{constructor}} {{toString}} {{hasOwnProperty}} {{__proto__}}", vars),
    "{{constructor}} {{toString}} {{hasOwnProperty}} {{__proto__}}",
  );
});
