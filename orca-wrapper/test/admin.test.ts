import { test } from "node:test";
import assert from "node:assert/strict";

// Same setup as auth.test.ts: config is read at import time, so env comes first.
process.env.ORCA_WRAPPER_TOKEN = "test-token";
process.env.ORCA_REPO_ID = "repo-id";
process.env.GITHUB_DRY_RUN = "1";
process.env.GITHUB_TOKEN = "gh-test";
process.env.PORT = "0";
process.env.DB_PATH = ":memory:";
process.env.ORCA_BIN = "/nonexistent";

const { startServer } = await import("../src/server.ts");
const { ensurePrSession, enqueueJob, claimNextJob, prKey } = await import("../src/db.ts");

const AUTH = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

async function withServer(fn: (base: string, ctx: { db: any; exits: number[] }) => Promise<void>): Promise<void> {
  const exits: number[] = [];
  const { server, close, db } = startServer({ exit: (code) => exits.push(code) });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`, { db, exits });
  } finally {
    close();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 400));

test("admin routes need the bearer token like every other route", async () => {
  await withServer(async (base) => {
    for (const [method, path] of [["GET", "/admin/health"], ["GET", "/admin/logs"], ["POST", "/admin/restart"], ["POST", "/admin/deploy"]]) {
      const res = await fetch(`${base}${path}`, { method });
      assert.strictEqual(res.status, 401, `${method} ${path}`);
    }
  });
});

test("GET /admin/health: commit, job counts, and the Orca check's error when Orca isn't reachable", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/admin/health`, { headers: AUTH });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.match(String(body.commit), /^[0-9a-f]{7,}$/);
    assert.strictEqual(body.running_jobs, 0);
    assert.strictEqual(body.queued_jobs, 0);
    assert.notStrictEqual(body.orca, "ok"); // ORCA_BIN=/nonexistent
  });
});

test("POST /admin/restart with nothing running: 202, then exits with the restart code", async () => {
  await withServer(async (base, { exits }) => {
    const res = await fetch(`${base}/admin/restart`, { method: "POST", headers: AUTH });
    assert.strictEqual(res.status, 202);
    await settle();
    assert.deepStrictEqual(exits, [75]);
  });
});

test("POST /admin/restart while a job runs: 409 naming it, no exit; force:true restarts anyway", async () => {
  await withServer(async (base, { db, exits }) => {
    ensurePrSession(db, 7, "feat/x");
    enqueueJob(db, prKey(7), 1, "alice", "go");
    const job = claimNextJob(db, prKey(7));
    assert.ok(job);

    const refused = await fetch(`${base}/admin/restart`, { method: "POST", headers: AUTH });
    assert.strictEqual(refused.status, 409);
    const body = (await refused.json()) as { running: Array<{ id: number; session_key: string }> };
    assert.deepStrictEqual(body.running, [{ id: job!.id, session_key: "pr-7" }]);
    await settle();
    assert.deepStrictEqual(exits, []);

    const forced = await fetch(`${base}/admin/restart`, { method: "POST", headers: AUTH, body: JSON.stringify({ force: true }) });
    assert.strictEqual(forced.status, 202);
    await settle();
    assert.deepStrictEqual(exits, [75]);
  });
});

test("POST /admin/deploy while a job runs: 409 before touching git", async () => {
  await withServer(async (base, { db, exits }) => {
    ensurePrSession(db, 8, "feat/y");
    enqueueJob(db, prKey(8), 2, "bob", "go");
    claimNextJob(db, prKey(8));
    const res = await fetch(`${base}/admin/deploy`, { method: "POST", headers: AUTH });
    assert.strictEqual(res.status, 409);
    await settle();
    assert.deepStrictEqual(exits, []);
  });
});
