// GitHub REST calls, via global fetch — just the endpoints the wrapper needs.
import { config } from "./config.ts";

const API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "orca-wrapper",
  };
}

async function post(path: string, body: unknown): Promise<void> {
  if (config.githubDryRun) {
    console.log(`[dry-run] POST ${path} ${JSON.stringify(body)}`);
    return;
  }
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 500);
    throw new Error(`github ${path} failed: ${res.status} ${snippet}`);
  }
}

export async function react(commentId: number, content: "eyes"): Promise<void> {
  await post(`/repos/${config.githubRepo}/issues/comments/${commentId}/reactions`, { content });
}

export async function comment(pr: number, body: string): Promise<void> {
  await post(`/repos/${config.githubRepo}/issues/${pr}/comments`, { body });
}

// GitHub answers an authenticated GET on an attachment URL with a 302 to a pre-signed S3 URL
// (valid for a few minutes, no auth needed) — anonymous requests get 404 on internal repos.
// We only want that Location, never the bytes: the agent host downloads them itself.
export async function resolveAttachment(url: string): Promise<string> {
  if (config.githubDryRun) {
    console.log(`[dry-run] resolve attachment ${url}`);
    return url;
  }
  const res = await fetch(url, {
    redirect: "manual",
    headers: { Authorization: `token ${config.githubToken}`, "User-Agent": "orca-wrapper" },
  });
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) {
    throw new Error(`attachment ${url}: expected 302 with Location, got ${res.status}`);
  }
  return location;
}

// Used to decide whether a task's branch has anything worth opening a PR for: the agent may end
// a run having pushed nothing (e.g. it only asked a question), and a PR with zero commits is
// nothing but noise. Dry-run answers 1 (pretend there's a commit) so the rest of the task flow —
// PR creation, the Notion-writeback job — still exercises in local smoke tests.
export async function compareAhead(base: string, head: string): Promise<number> {
  if (config.githubDryRun) {
    console.log(`[dry-run] GET compare ${base}...${head}`);
    return 1;
  }
  const res = await fetch(`${API}/repos/${config.githubRepo}/compare/${base}...${head}`, { headers: authHeaders() });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 500);
    throw new Error(`github compare ${base}...${head} failed: ${res.status} ${snippet}`);
  }
  const body = (await res.json()) as { ahead_by: number };
  return body.ahead_by;
}

// Opens the PR for a task once its branch has commits. Never a draft — the wrapper only calls
// this once real work has landed. Dry-run returns a fake but well-formed PR so the rest of the
// task flow (storing session.pr, enqueuing the Notion-writeback job) still runs in local tests.
export async function createPullRequest(params: {
  title: string;
  head: string;
  base: string;
  body: string;
}): Promise<{ number: number; html_url: string }> {
  if (config.githubDryRun) {
    console.log(`[dry-run] POST /repos/${config.githubRepo}/pulls ${JSON.stringify(params)}`);
    // Non-zero: PR 0 is falsy, and `if (session.pr)` then treated the task as having no PR yet.
    return { number: 99999, html_url: "https://example.invalid/pr/99999" };
  }
  const res = await fetch(`${API}/repos/${config.githubRepo}/pulls`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 500);
    throw new Error(`github create PR failed: ${res.status} ${snippet}`);
  }
  const json = (await res.json()) as { number: number; html_url: string };
  return { number: json.number, html_url: json.html_url };
}

// Checked before queueing a prompt: a closed PR's close event has already fired, so a session
// opened for it now would never be torn down. Dry-run pretends every PR is open.
export async function pullState(pr: number): Promise<"open" | "closed"> {
  if (config.githubDryRun) {
    console.log(`[dry-run] GET /repos/${config.githubRepo}/pulls/${pr}`);
    return "open";
  }
  const res = await fetch(`${API}/repos/${config.githubRepo}/pulls/${pr}`, { headers: authHeaders() });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 500);
    throw new Error(`github get PR #${pr} failed: ${res.status} ${snippet}`);
  }
  const body = (await res.json()) as { state: string };
  return body.state === "closed" ? "closed" : "open";
}

// The PR (any state) whose head is `branch` in this repo, newest first — for a re-dispatched work
// order, whose branch may already have one. Dry-run: none.
export async function findPullByHead(
  branch: string,
): Promise<{ number: number; html_url: string; state: "open" | "closed"; merged: boolean } | null> {
  if (config.githubDryRun) {
    console.log(`[dry-run] GET /repos/${config.githubRepo}/pulls?head=…:${branch}&state=all`);
    return null;
  }
  const owner = config.githubRepo.split("/")[0];
  const q = new URLSearchParams({ head: `${owner}:${branch}`, state: "all", sort: "created", direction: "desc" });
  const res = await fetch(`${API}/repos/${config.githubRepo}/pulls?${q}`, { headers: authHeaders() });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 500);
    throw new Error(`github list PRs for ${branch} failed: ${res.status} ${snippet}`);
  }
  const list = (await res.json()) as Array<{ number: number; html_url: string; state: string; merged_at: string | null }>;
  const pr = list[0];
  if (!pr) return null;
  return { number: pr.number, html_url: pr.html_url, state: pr.state === "closed" ? "closed" : "open", merged: pr.merged_at != null };
}

export async function reopenPullRequest(pr: number): Promise<void> {
  if (config.githubDryRun) {
    console.log(`[dry-run] PATCH /repos/${config.githubRepo}/pulls/${pr} {"state":"open"}`);
    return;
  }
  const res = await fetch(`${API}/repos/${config.githubRepo}/pulls/${pr}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ state: "open" }),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 500);
    throw new Error(`github reopen PR #${pr} failed: ${res.status} ${snippet}`);
  }
}

// Secret gist holding a full answer too long for one comment. Needs the token's `gist` scope
// (gh's default login has it); the caller falls back to several comments if this throws.
export async function createGist(filename: string, content: string, description: string): Promise<string> {
  if (config.githubDryRun) {
    console.log(`[dry-run] POST /gists ${filename} (${content.length} chars)`);
    return "https://gist.example.invalid/dry-run";
  }
  const res = await fetch(`${API}/gists`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ description, public: false, files: { [filename]: { content } } }),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 300);
    throw new Error(`github create gist failed: ${res.status} ${snippet}`);
  }
  return ((await res.json()) as { html_url: string }).html_url;
}
