import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// answer.ts pulls in orca.ts -> config.ts, which reads env at import time.
process.env.ORCA_WRAPPER_TOKEN = "test-token";
process.env.ORCA_REPO_ID = "repo-id";
process.env.GITHUB_DRY_RUN = "1";
process.env.GITHUB_TOKEN = "gh-test";
process.env.DB_PATH = ":memory:";
const { ANSWER_END, COMMENT_MAX_CHARS, decodeAnswer, extractCommand, looksCapped, matchesSnapshot, splitText } = await import("../src/answer.ts");

// What `base64 -w 4000` + the end marker look like after `terminal read`, with the typed command
// line and a shell prompt around it.
function terminalTail(text: string): string[] {
  const b64 = gzipSync(Buffer.from(text, "utf8")).toString("base64");
  const lines = b64.match(/.{1,4000}/g) ?? [];
  return ["dev@host:~/wt$ python3 -c ... ; echo " + ANSWER_END, ...lines, ANSWER_END, "dev@host:~/wt$"];
}

test("looksCapped: at Orca's ~8 KB cap (or flagged) -> recover; short answers -> as-is", () => {
  assert.strictEqual(looksCapped("short answer", false), false);
  assert.strictEqual(looksCapped("x".repeat(8036), false), true);
  assert.strictEqual(looksCapped("ก".repeat(2400), false), true); // 3 bytes each: 7,200 bytes
  assert.strictEqual(looksCapped("short", true), true);
});

test("decodeAnswer: round-trips the gzip+base64 lines, Thai included", () => {
  const text = "สรุป: แก้ 3 ไฟล์\n\n```\n" + "line\n".repeat(5000) + "```";
  assert.strictEqual(decodeAnswer(terminalTail(text)), text);
});

test("decodeAnswer: null before the end marker, or when retention dropped the start", () => {
  const tail = terminalTail("hello ".repeat(20000));
  assert.strictEqual(decodeAnswer(tail.slice(0, 2)), null); // still printing
  assert.strictEqual(decodeAnswer([tail[0], ...tail.slice(2)]), null); // first base64 line lost
});

test("matchesSnapshot: the transcript must start the way Orca's snapshot does", () => {
  const full = "## Result\n\nAll   three checks pass.\n" + "detail ".repeat(3000);
  assert.strictEqual(matchesSnapshot(full, "## Result All three checks pass. detail detail"), true);
  assert.strictEqual(matchesSnapshot(full, "Something from a different session entirely"), false);
  assert.strictEqual(matchesSnapshot(full, "   "), false);
});

test("splitText: pieces fit, break at newlines, and rejoin to the original", () => {
  const text = Array.from({ length: 30000 }, (_, i) => `line ${i}`).join("\n");
  const parts = splitText(text);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= COMMENT_MAX_CHARS);
  assert.strictEqual(parts.join("\n"), text);
  assert.deepStrictEqual(splitText("short"), ["short"]);
});

test("extractCommand: prints the final message of the newest transcript for the cwd, not the narration", (t) => {
  try {
    execFileSync("python3", ["--version"]);
  } catch {
    t.skip("python3 not installed");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "orca-answer-home-"));
  const cwd = join(home, "repo-pr-7");
  mkdirSync(cwd);
  const project = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const final = "Done — changed `a.ts`.\n\nQUESTION: ship it?";
  const lines = [
    { type: "user", message: { content: "do it" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Let me look first." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "…" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: final }] } },
  ];
  writeFileSync(join(project, "s.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    const out = execFileSync("bash", ["-c", extractCommand()], { cwd, env: { ...process.env, HOME: home } }).toString();
    assert.strictEqual(decodeAnswer(out.trimEnd().split("\n")), final);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
