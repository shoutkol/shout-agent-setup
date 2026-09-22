// Pure functions with no I/O, split out so the test suite can exercise the tricky decision logic
// (command parsing, completion detection, output stabilisation) without touching Orca or GitHub.

export type Command = { type: "stop" } | { type: "prompt"; prompt: string } | null;

// GitHub Actions forwards the raw PR comment body. A valid command is "/orca" at the very start
// of the (trimmed) comment, followed by either nothing, or whitespace + the rest of the prompt.
// "/orcaX" and "hello /orca" are not commands — the workflow filters these too, but the server
// must not trust that and re-checks here.
export function parseCommand(body: string): Command {
  const match = /^\/orca(?:\s+([\s\S]*))?$/.exec(body.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return null; // bare "/orca" — nothing to run
  if (rest.toLowerCase() === "stop") return { type: "stop" };
  return { type: "prompt", prompt: rest };
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
// got posted to a PR verbatim (PR 482). The frame always echoes the launch flag and our preamble;
// a real answer never contains the preamble verbatim and never ends in a shell prompt.
export function isLaunchFrame(content: string, preambleMarker: string): boolean {
  const c = content.trim();
  if (c === "") return true;
  if (c.includes("--dangerously-skip-permissions")) return true;
  if (preambleMarker && c.includes(preambleMarker)) return true;
  return /\$\s*$/.test(c);
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
// rather than blanked, so a typo in the Notion prompt fails loudly instead of silently vanishing;
// a template with no placeholders at all is returned unchanged.
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? vars[key] : match));
}
