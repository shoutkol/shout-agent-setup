import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// RM-815: shout's release manager asks for `/release-notes <n>` on a PR after it is merged into
// main, and every command on a closed PR used to be refused — so hotfixes merged straight into main
// (#896, #1207, #1134) were never announced. Only that request, on that kind of PR, is accepted now.
//
// GitHub is real-mode with fetch stubbed for api.github.com only (the tests' own requests to the
// server go through the real fetch). Orca is a fake that logs every call to FAKE_ORCA_LOG, so the
// worker that picks the job up can be seen choosing the ref and the preamble.
const orcaLog = join(mkdtempSync(join(tmpdir(), "orca-release-")), "calls.log");
writeFileSync(orcaLog, "");
process.env.ORCA_WRAPPER_TOKEN = "test-token";
process.env.ORCA_REPO_ID = "r";
process.env.GITHUB_TOKEN = "x";
process.env.PORT = "0";
process.env.DB_PATH = ":memory:";
process.env.ORCA_BIN = fileURLToPath(new URL("./fixtures/fake-orca-release.sh", import.meta.url));
process.env.FAKE_ORCA_LOG = orcaLog;

const { startServer } = await import("../src/server.ts");
const dbm = await import("../src/db.ts");

type Pull = { state: "open" | "closed"; merged: boolean; base: string };
const pulls = new Map<number, Pull>();
const comments: Array<{ pr: number; body: string }> = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.github.com/")) return realFetch(input as any, init);
  const issue = /\/issues\/(\d+)\/comments$/.exec(url);
  if (issue && init?.method === "POST") {
    comments.push({ pr: Number(issue[1]), body: JSON.parse(String(init.body)).body });
    return new Response("{}", { status: 201 });
  }
  const pull = /\/pulls\/(\d+)$/.exec(url);
  if (pull) {
    const p = pulls.get(Number(pull[1])) ?? { state: "open", merged: false, base: "dev" };
    return new Response(
      JSON.stringify({ state: p.state, merged: p.merged, merged_at: p.merged ? "2026-10-28T00:00:00Z" : null, base: { ref: p.base } }),
    );
  }
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const MARKER = "[orca-request kind=release author=github-actions]";
// Exactly what tools/release-notes/cli.mjs sendOrca posts: comment_id 0, the marker, then the prompt.
const releaseBody = (pr: number, prompt: string, head_ref = "hotfix/gone") =>
  JSON.stringify({ head_ref, base_ref: "main", comment_id: 0, body: `/orca ${MARKER}\n${prompt}`, author: "github-actions" });

async function withServer(fn: (base: string, db: ReturnType<typeof startServer>["db"]) => Promise<void>): Promise<void> {
  const { server, close, db } = startServer();
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`, db);
  } finally {
    // Let the worker's in-flight job (it fails against the fake orca) settle before the DB closes.
    await waitFor(() => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running')").get() as { n: number }).n === 0, 10_000);
    close();
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

const post = (base: string, pr: number, body: string) =>
  fetch(`${base}/pr/${pr}/prompt`, { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body });

const jobCount = (db: ReturnType<typeof startServer>["db"], pr: number) =>
  (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE session_key = ?").get(`pr-${pr}`) as { n: number }).n;

test("merged into main + /release-notes <n> (and `final`) -> queued on pr-<n>, checked out on main (head branch deleted)", async () => {
  pulls.set(1207, { state: "closed", merged: true, base: "main" });
  await withServer(async (base, db) => {
    const res = await post(base, 1207, releaseBody(1207, "/release-notes 1207", "fix/deleted-head"));
    assert.strictEqual(res.status, 202);
    const json = (await res.json()) as { job_id?: number; pr_closed?: boolean };
    assert.strictEqual(json.pr_closed, undefined);
    assert.strictEqual(typeof json.job_id, "number");

    // The head branch is gone: the session is keyed pr-1207 as always, but checked out on main.
    const session = dbm.getSession(db, "pr-1207");
    assert.strictEqual(session?.kind, "pr");
    assert.strictEqual(session?.head_ref, "main");
    await waitFor(() => readFileSync(orcaLog, "utf8").includes("git fetch origin 'main'"), 10_000);
    assert.match(readFileSync(orcaLog, "utf8"), /git fetch origin 'main'/);
    assert.doesNotMatch(readFileSync(orcaLog, "utf8"), /deleted-head/);

    const final = await post(base, 1207, releaseBody(1207, "/release-notes 1207 final", "fix/deleted-head"));
    assert.strictEqual(final.status, 202);
    assert.strictEqual(typeof ((await final.json()) as { job_id?: number }).job_id, "number");
    assert.strictEqual(jobCount(db, 1207), 2);
    assert.ok(!comments.some((c) => c.pr === 1207 && c.body.includes("is closed")));
  });
});

test("the same request without the marker (posted as a plain `/orca /release-notes <n>` comment) is accepted too", async () => {
  pulls.set(896, { state: "closed", merged: true, base: "main" });
  await withServer(async (base, db) => {
    const body = JSON.stringify({ head_ref: "hotfix/x", base_ref: "main", comment_id: 8960, body: "/orca /release-notes 896", author: "mmoladaa" });
    const res = await post(base, 896, body);
    assert.strictEqual(res.status, 202);
    assert.strictEqual(jobCount(db, 896), 1);
  });
});

test("merged into main + any other prompt -> refused with the closed-PR note, nothing queued", async () => {
  pulls.set(1134, { state: "closed", merged: true, base: "main" });
  await withServer(async (base, db) => {
    for (const prompt of ["please fix the typo", "/release-notes 999", "/release-notes 1134 now", "/release-notes"]) {
      comments.length = 0;
      const res = await post(base, 1134, releaseBody(1134, prompt));
      assert.strictEqual(res.status, 202, prompt);
      assert.deepStrictEqual(await res.json(), { pr_closed: true }, prompt);
      assert.deepStrictEqual(comments, [
        { pr: 1134, body: "🐳 orca: PR #1134 is closed, so there's no session to run this in. Reopen the PR to use /orca again." },
      ]);
    }
    assert.strictEqual(jobCount(db, 1134), 0);
    assert.strictEqual(dbm.getSession(db, "pr-1134"), undefined);
  });
});

test("closed without merging + /release-notes -> refused", async () => {
  pulls.set(700, { state: "closed", merged: false, base: "main" });
  await withServer(async (base, db) => {
    const res = await post(base, 700, releaseBody(700, "/release-notes 700"));
    assert.deepStrictEqual(await res.json(), { pr_closed: true });
    assert.strictEqual(jobCount(db, 700), 0);
  });
});

test("merged into a base other than main + /release-notes -> refused", async () => {
  pulls.set(701, { state: "closed", merged: true, base: "dev" });
  await withServer(async (base, db) => {
    const res = await post(base, 701, releaseBody(701, "/release-notes 701"));
    assert.deepStrictEqual(await res.json(), { pr_closed: true });
    assert.strictEqual(jobCount(db, 701), 0);
  });
});

test("a session still open for the merged PR is reused as it is, and DELETE /pr/<n> closes it", async () => {
  pulls.set(702, { state: "closed", merged: true, base: "main" });
  await withServer(async (base, db) => {
    const existing = dbm.ensurePrSession(db, 702, "fix/kept");
    dbm.updateSession(db, existing.key, { state: "ready", worktree_id: "wt-702" });

    const res = await post(base, 702, releaseBody(702, "/release-notes 702", "fix/kept"));
    assert.strictEqual(res.status, 202);
    const job = db.prepare("SELECT session_key FROM jobs WHERE session_key = ?").get(existing.key) as { session_key: string } | undefined;
    assert.strictEqual(job?.session_key, "pr-702");
    assert.strictEqual(dbm.getSession(db, "pr-702")?.head_ref, "fix/kept");
    assert.strictEqual(dbm.getSession(db, "pr-702")?.worktree_id, "wt-702");
    await waitFor(() => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running')").get() as { n: number }).n === 0, 10_000);

    const del = await fetch(`${base}/pr/702`, { method: "DELETE", headers: { Authorization: "Bearer test-token" } });
    assert.strictEqual(del.status, 202);
    assert.deepStrictEqual(await del.json(), { closed: true });
    assert.strictEqual(dbm.getSession(db, "pr-702")?.state, "closed");
    assert.match(readFileSync(orcaLog, "utf8"), /worktree rm --worktree id:wt-702/);
  });
});

test("a later session on main runs its release-notes prompt behind the read-only preamble, not `push HEAD:main`", async () => {
  pulls.set(703, { state: "closed", merged: true, base: "main" });
  await withServer(async (base, db) => {
    const s = dbm.ensurePrSession(db, 703, "main");
    dbm.updateSession(db, s.key, { state: "ready", worktree_id: "wt-703" });
    await post(base, 703, releaseBody(703, "/release-notes 703"));
    await waitFor(() => readFileSync(orcaLog, "utf8").includes("automations create --name pr-703"), 10_000);
    const create = readFileSync(orcaLog, "utf8").split("\n").find((l) => l.includes("automations create --name pr-703")) ?? "";
    assert.match(create, /checked out on `origin\/main`, because PR #703 is already merged into main/);
    assert.doesNotMatch(create, /push origin HEAD:main/);
  });
});

test("comment_id 0 is not an id: a second release request is not deduped against another PR's job", async () => {
  pulls.set(704, { state: "closed", merged: true, base: "main" });
  pulls.set(705, { state: "closed", merged: true, base: "main" });
  await withServer(async (base, db) => {
    const a = (await (await post(base, 704, releaseBody(704, "/release-notes 704"))).json()) as { job_id: number; deduped?: boolean };
    const b = (await (await post(base, 705, releaseBody(705, "/release-notes 705"))).json()) as { job_id: number; deduped?: boolean };
    assert.notStrictEqual(b.job_id, a.job_id);
    assert.strictEqual(b.deduped, undefined);
    assert.strictEqual(jobCount(db, 705), 1);
  });
});

test("an open PR is unaffected: any prompt is queued on its own head branch", async () => {
  pulls.set(706, { state: "open", merged: false, base: "dev" });
  await withServer(async (base, db) => {
    const body = JSON.stringify({ head_ref: "feat/open", base_ref: "dev", comment_id: 7060, body: "/orca hi", author: "alice" });
    assert.strictEqual((await post(base, 706, body)).status, 202);
    assert.strictEqual(dbm.getSession(db, "pr-706")?.head_ref, "feat/open");
  });
});
