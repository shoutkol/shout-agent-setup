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

// Sent on every run of a task session (not just the first) for the same reason preamble() above
// re-sends its ground rules every time: the automation's prompt is fully replaced on each
// `automations edit`, so anything the agent must be reminded of has to be in the text we send.
// The one exception is the auto-generated "write the PR back to Notion" follow-up job, which uses
// its own prompt verbatim (see worker.ts) — repeating "do not update the Notion page yet" right
// before asking it to do exactly that would be self-contradicting.
export function taskPreamble(branch: string, wo: number, title: string, notionUrl: string, repoApp: string | null): string {
  const repoLine = repoApp ? ` The work touches: ${repoApp}.` : "";
  return (
    `${PREAMBLE_MARKER} \`${branch}\` of shoutkol/shout, created from \`dev\` for Work Order ` +
    `WO-${wo} "${title}": ${notionUrl}. First read that Notion page with your Notion tools ` +
    `(claude.ai Notion connector) — it is the spec. Implement it. Commit as you go and ALWAYS ` +
    `\`git push origin ${branch}\` before you finish, even if the work is incomplete or you are ` +
    `blocked — the pull request is where open questions get discussed. Do not create other ` +
    `branches or PRs (the wrapper opens the PR) and do not update the Notion page yet. End with a ` +
    `concise summary of what changed and what is left; put each open question on its own line ` +
    `starting \`QUESTION:\`.${repoLine}`
  );
}
