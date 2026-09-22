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
