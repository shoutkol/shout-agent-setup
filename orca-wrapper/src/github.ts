// GitHub REST calls, via global fetch — just the two endpoints the wrapper needs.
import { config } from "./config.ts";

const API = "https://api.github.com";

async function post(path: string, body: unknown): Promise<void> {
  if (config.githubDryRun) {
    console.log(`[dry-run] POST ${path} ${JSON.stringify(body)}`);
    return;
  }
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "orca-wrapper",
      "Content-Type": "application/json",
    },
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
