// Images pasted into a GitHub comment arrive in the body as markdown/HTML links to
// github.com/user-attachments/assets/<uuid> (or the older <owner>/<repo>/assets/<id>). On an
// internal repo those URLs 404 without auth, and the agent host has no GitHub credentials, so
// the wrapper resolves each one to GitHub's short-lived pre-signed S3 URL (needs the token, see
// github.resolveAttachment) and has a throwaway terminal in the worktree download it to a path
// outside the checkout. The prompt then refers to the local files instead of the URLs.
const ATTACHMENT_URL = /https:\/\/github\.com\/(?:user-attachments\/assets\/[0-9a-f-]+|[\w.-]+\/[\w.-]+\/assets\/\d+)/g;
const MAX_ATTACHMENTS = 5;

export interface Attachment {
  url: string;
  path: string; // absolute path on the agent host, outside the repo so it can't be committed
}

export function extractAttachmentUrls(body: string): string[] {
  return [...new Set(body.match(ATTACHMENT_URL) ?? [])].slice(0, MAX_ATTACHMENTS);
}

export function attachmentDir(pr: number): string {
  return `/tmp/orca-attachments/pr-${pr}`;
}

// File extension from the signed URL's object key (".../<id>.png?X-Amz-..."), default png.
export function extensionOf(signedUrl: string): string {
  const m = /\.([a-zA-Z0-9]{2,5})(?:\?|$)/.exec(new URL(signedUrl).pathname);
  return m ? m[1].toLowerCase() : "png";
}

// One shell line for `orca terminal create --command`: download every file, then exit so
// `terminal wait --for exit` fires. Signed URLs carry & and % but never a single quote.
export function downloadCommand(dir: string, files: Array<{ signedUrl: string; path: string }>): string {
  const curls = files.map((f) => `curl -fsSL -o '${f.path}' '${f.signedUrl}'`).join(" && ");
  return `mkdir -p '${dir}' && ${curls}; exit`;
}

// Swap each attachment URL in the prompt for its local path and append a pointer, so the agent
// reads the files instead of trying (and failing) to fetch the URLs.
export function rewritePrompt(prompt: string, attachments: Attachment[]): string {
  let out = prompt;
  for (const a of attachments) out = out.split(a.url).join(a.path);
  const list = attachments.map((a) => `- ${a.path}`).join("\n");
  return `${out}\n\nImages attached to the comment were saved on this machine — open and look at them before answering:\n${list}`;
}
