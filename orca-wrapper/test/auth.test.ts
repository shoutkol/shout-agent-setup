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
