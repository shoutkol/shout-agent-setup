// Prepended to every prompt sent to the agent so it knows the ground rules of the worktree
// it's running in. Kept as one hard-coded string, not configurable — there is exactly one caller.
// First words of every preamble; logic.isLaunchFrame uses it to spot the terminal echoing our
// own prompt back (the launch frame) so it is never mistaken for the agent's answer.
export const PREAMBLE_MARKER = "You are working in a git worktree checked out on branch";

export function preamble(headRef: string, pr: number): string {
  return (
    `${PREAMBLE_MARKER} \`${headRef}\` of shoutkol/shout, ` +
    `which is the head branch of PR #${pr}. Run \`git pull --ff-only\` first — the branch may have ` +
    `moved since your last turn. Work only on this branch. When you change code, ` +
    `commit and \`git push origin ${headRef}\`; never create branches or PRs. Do not post GitHub ` +
    `comments yourself — your final reply is posted to the PR automatically, so make it a concise ` +
    `summary; if you are blocked or need a decision, end with a line starting \`QUESTION:\`.`
  );
}
