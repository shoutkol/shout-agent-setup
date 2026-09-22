import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAttachmentUrls, extensionOf, downloadCommand, rewritePrompt } from "../src/attachments.ts";

const A = "https://github.com/user-attachments/assets/3b2208a8-e240-4651-b42a-5cd23ab61706";
const B = "https://github.com/shoutkol/shout/assets/12345";

test("extracts markdown and <img> attachment urls, deduplicated", () => {
  const body = `/orca look\n![img](${A})\n<img width="600" alt="x" src="${A}">\n${B}`;
  assert.deepStrictEqual(extractAttachmentUrls(body), [A, B]);
});

test("ignores other github urls", () => {
  assert.deepStrictEqual(extractAttachmentUrls("see https://github.com/shoutkol/shout/pull/416 please"), []);
});

test("extension comes from the signed url's object key, png by default", () => {
  assert.strictEqual(extensionOf("https://s3.amazonaws.com/x/656318120-3b2208a8.png?X-Amz-Algorithm=AWS4"), "png");
  assert.strictEqual(extensionOf("https://s3.amazonaws.com/x/abc.JPEG?X-Amz-Algorithm=AWS4"), "jpeg");
  assert.strictEqual(extensionOf("https://s3.amazonaws.com/x/noext?X-Amz-Algorithm=AWS4"), "png");
});

test("download command makes the dir, fetches each file, then exits", () => {
  const cmd = downloadCommand("/tmp/orca-attachments/pr-7", [
    { signedUrl: "https://s3/a.png?X-Amz-Signature=1&x=2", path: "/tmp/orca-attachments/pr-7/3-1.png" },
  ]);
  assert.strictEqual(
    cmd,
    "mkdir -p '/tmp/orca-attachments/pr-7' && curl -fsSL -o '/tmp/orca-attachments/pr-7/3-1.png' 'https://s3/a.png?X-Amz-Signature=1&x=2'; exit",
  );
});

test("prompt urls are replaced by local paths and the files are listed", () => {
  const out = rewritePrompt(`describe ![img](${A})`, [{ url: A, path: "/tmp/orca-attachments/pr-7/3-1.png" }]);
  assert.ok(out.startsWith("describe ![img](/tmp/orca-attachments/pr-7/3-1.png)"));
  assert.ok(out.includes("- /tmp/orca-attachments/pr-7/3-1.png"));
  assert.ok(!out.includes(A));
});
