// Prepended to every prompt that comes from a PR comment — plain PR sessions and /orca comments
// on a work order's PR alike — so the agent knows the ground rules of the worktree it's running
// in. Kept as one hard-coded string, not configurable.
// First words of every preamble; logic.isLaunchFrame uses it to spot the terminal echoing our
// own prompt back (the launch frame) so it is never mistaken for the agent's answer.
export const PREAMBLE_MARKER = "You are working in a git worktree of shoutkol/shout";

// The worktree's local branch is not always named after the PR's head branch (a plain PR session
// uses its own, see worker.localBranchFor, so it never collides with another checkout of the same
// branch), so the push always names the remote branch explicitly.
export function preamble(headRef: string, pr: number): string {
  return (
    `${PREAMBLE_MARKER} whose local branch tracks \`origin/${headRef}\`, the head branch of PR #${pr}. ` +
    `Run \`git pull --ff-only\` first — the branch may have moved since your last turn. Work only on ` +
    `this branch. When you change code, commit and \`git push origin HEAD:${headRef}\`; never create ` +
    `branches or PRs. Do not post GitHub comments yourself — your final reply is posted to the PR ` +
    `automatically, so make it a concise summary; if you are blocked or need a decision, end with a ` +
    `line starting \`QUESTION:\`.`
  );
}
