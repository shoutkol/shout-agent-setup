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
