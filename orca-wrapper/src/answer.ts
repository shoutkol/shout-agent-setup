// Long answers. Orca's run `outputSnapshot` is capped at ~8 KB with no flag set (seen live: a
// 72,894-char answer came back as 8,036 bytes, cut mid-line), and GitHub rejects a comment over
// 65,536 chars. So when a snapshot looks capped, the worker recovers the agent's full final
// message from Claude's own transcript on the agent host, and posting splits what can't fit.
//
// Getting bytes back from the agent host: the only channel is `orca terminal read`, which keeps
// ~32 KB of a terminal's output. So the transcript extract is gzipped, base64'd in 4,000-char
// lines, and printed one line per second, while the worker reads new lines by cursor (see
// readFullAnswer) — the retention window never fills. A 73 KB answer (`seq 1 14000`) is 11 lines.
import { gunzipSync } from "node:zlib";
import * as orca from "./orca.ts";

export const SNAPSHOT_CAP_BYTES = 7_000; // at or above this, assume Orca cut the snapshot
export const COMMENT_MAX_CHARS = 60_000; // GitHub's hard limit is 65,536; leave room for the header
export const ANSWER_END = "__ORCA_ANSWER_END__";

export function looksCapped(content: string, truncatedFlag: boolean): boolean {
  return truncatedFlag || Buffer.byteLength(content, "utf8") >= SNAPSHOT_CAP_BYTES;
}

// Prints the final assistant message of the newest Claude transcript for this directory —
// Claude stores it under ~/.claude/projects/<cwd with every non-alphanumeric as "->/. The final
// message is the text after the last tool call or tool result: text before a tool call is the
// agent narrating, not its answer. Does NOT exit, so the terminal stays readable until closed.
const EXTRACT_PY = `
import os, re, json, glob
d = os.path.expanduser("~/.claude/projects/" + re.sub(r"[^a-zA-Z0-9]", "-", os.getcwd()))
files = sorted(glob.glob(d + "/*.jsonl"), key=os.path.getmtime)
out = []
for line in (open(files[-1], encoding="utf-8") if files else []):
    try:
        o = json.loads(line)
    except Exception:
        continue
    c = (o.get("message") or {}).get("content")
    if o.get("type") == "user":
        out = []
    elif o.get("type") == "assistant" and isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text", ""))
            elif isinstance(b, dict) and b.get("type") == "tool_use":
                out = []
print("\\n\\n".join(out), end="")
`;

// One line: Orca types the command into an interactive shell, and a multi-line `python3 -c '…'`
// is fed through line by line (several seconds, PS2 prompts in the output).
export function extractCommand(): string {
  const program = Buffer.from(EXTRACT_PY, "utf8").toString("base64");
  return (
    `python3 -c "$(echo ${program} | base64 -d)" | gzip -c | base64 -w 4000 | ` +
    `while IFS= read -r l; do echo "$l"; sleep 1; done; echo ${ANSWER_END}`
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs extractCommand in the worktree and collects its output by line number, reading only new
// lines each second. Null if it doesn't finish in time, Orca dropped lines before they were read,
// or the result doesn't decode. The terminal is closed either way.
export async function readFullAnswer(worktreeId: string, maxMs = 180_000): Promise<string | null> {
  const h = await orca.terminalCreate(worktreeId, "answer", extractCommand());
  const byLine = new Map<number, string>();
  let cursor: number | undefined;
  try {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await sleep(1_000);
      const r = await orca.terminalRead(h, cursor);
      if (cursor !== undefined && r.oldest > cursor) return null; // lines we never saw are gone
      r.lines.forEach((line, i) => byLine.set(r.start + i, line)); // a re-read line overwrites
      cursor = Math.max(r.start, r.next - 1); // re-read the last line: it may have been partial
      const ordered = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
      if (ordered.includes(ANSWER_END)) return decodeAnswer(ordered);
    }
    return null;
  } finally {
    await orca.terminalClose(h).catch(() => {});
  }
}

// Decodes what `terminal read` returned. Null if the end marker isn't there yet, or if the
// terminal's retention dropped the start (the gzip stream then fails to decode).
export function decodeAnswer(tail: string[]): string | null {
  const end = tail.lastIndexOf(ANSWER_END);
  if (end < 0) return null;
  const b64 = tail
    .slice(0, end)
    .filter((l) => /^[A-Za-z0-9+/=]+$/.test(l))
    .join("");
  if (!b64) return null;
  try {
    return gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
  } catch {
    return null;
  }
}

// The transcript is the right one if it starts the way the snapshot does.
export function matchesSnapshot(full: string, snapshot: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const head = norm(snapshot).slice(0, 80);
  return head.length > 0 && norm(full).slice(0, 400).includes(head);
}

// Splits at line breaks into pieces of at most `max` chars (a single longer line is cut hard).
export function splitText(text: string, max = COMMENT_MAX_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  parts.push(rest);
  return parts;
}
