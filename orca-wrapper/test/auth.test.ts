import { test } from "node:test";
import assert from "node:assert/strict";

// Env vars must be set before src/config.ts (imported transitively via src/server.ts) reads
// them. node --test runs each test file in its own process, so this doesn't leak elsewhere.
process.env.ORCA_WRAPPER_TOKEN = "test-token";
process.env.ORCA_REPO_ID = "repo-id";
process.env.GITHUB_DRY_RUN = "1";
process.env.GITHUB_TOKEN = "gh-test";
process.env.PORT = "0";
process.env.DB_PATH = ":memory:";
// No real orca CLI here. POST /tasks below enqueues a job that the in-process worker picks up
// asynchronously — its first orca call (repoPath, inside ensureWorktree) fails fast against this
// nonexistent binary, exercising processJob's catch path without touching a real Orca install.
process.env.ORCA_BIN = "/nonexistent";

const { startServer } = await import("../src/server.ts");

test("GET /sessions: no/wrong/right bearer token -> 401/401/200", async () => {
  const { server, close } = startServer();
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const noAuth = await fetch(`${base}/sessions`);
    assert.strictEqual(noAuth.status, 401);

    const wrongAuth = await fetch(`${base}/sessions`, { headers: { Authorization: "Bearer nope" } });
    assert.strictEqual(wrongAuth.status, 401);

    const rightAuth = await fetch(`${base}/sessions`, { headers: { Authorization: "Bearer test-token" } });
    assert.strictEqual(rightAuth.status, 200);
  } finally {
    close();
  }
});

test("POST /tasks: missing/invalid fields -> 400", async () => {
  const { server, close } = startServer();
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const cases = [
      {}, // nothing at all
      { notion_url: "https://not-a-real-host.example/x", wo: 12, title: "Campaign owner credit", prompt: "go" }, // not a notion URL
      { notion_url: "https://notion.so/x", wo: 0, title: "Campaign owner credit", prompt: "go" }, // wo not positive
      { notion_url: "https://notion.so/x", wo: 12, title: "", prompt: "go" }, // blank title
      { notion_url: "https://notion.so/x", wo: 12, title: "Campaign owner credit" }, // missing prompt
      { notion_url: "https://notion.so/x", wo: 12, title: "Campaign owner credit", prompt: "   " }, // blank prompt
    ];
    for (const body of cases) {
      const res = await fetch(`${base}/tasks`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
  } finally {
    close();
  }
});

test("POST /tasks: valid body -> 202 with the wo-<n> session key, even though the worker's first orca call will fail", async () => {
  const { server, close } = startServer();
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        notion_url: "https://www.notion.so/Campaign-owner-credit-abc123",
        wo: 12,
        title: "Campaign owner credit",
        prompt: "Implement {{title}} on {{branch}}.",
      }),
    });
    assert.strictEqual(res.status, 202);
    const body = (await res.json()) as { key: string; job_id: number; position: number };
    assert.strictEqual(body.key, "wo-12");
    assert.strictEqual(typeof body.job_id, "number");
    assert.strictEqual(body.position, 1);
  } finally {
    close();
  }
});

test("POST /tasks: n8n-style stringy fields (wo \"73\", repo_app as a JSON string) are coerced -> 202", async () => {
  const { server, close } = startServer();
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ notion_url: "https://app.notion.com/p/abc", wo: "73", title: "TEST", repo_app: '["shout-web"]', prompt: "go" }),
    });
    assert.strictEqual(res.status, 202);
    const json = (await res.json()) as { key: string };
    assert.strictEqual(json.key, "wo-73");
  } finally {
    close();
  }
});
