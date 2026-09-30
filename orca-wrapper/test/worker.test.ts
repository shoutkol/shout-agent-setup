import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Job } from "../src/db.ts";

// A work order's first run that outlives RUN_TIMEOUT_MIN. Seen live on wo-444: the wrapper timed
// out at 60 min, the agent finished and pushed 7 min later, and no PR ever opened. The fake orca
// keeps the run "dispatched" forever; dry-run GitHub reports the branch one commit ahead of dev.
process.env.ORCA_WRAPPER_TOKEN = "t";
process.env.ORCA_REPO_ID = "r";
process.env.GITHUB_DRY_RUN = "1";
process.env.GITHUB_TOKEN = "x";
process.env.DB_PATH = ":memory:";
process.env.RUN_TIMEOUT_MIN = "0.001";
process.env.ORCA_BIN = fileURLToPath(new URL("./fixtures/fake-orca-task.sh", import.meta.url));

const db = await import("../src/db.ts");
const { createWorker } = await import("../src/worker.ts");

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

test("a first run that times out still opens the PR when its branch has commits", async () => {
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    const handle = db.openDb(":memory:");
    const worker = createWorker(handle);
    const key = db.taskKey(444);
    worker.enqueueTask(444, "https://app.notion.com/p/x", "seeding", "guy", "claude/WO-444-seeding", null, "/dev-agent {{notion_url}}");

    const jobs = () => handle.prepare("SELECT kind, state, error FROM jobs WHERE session_key = ? ORDER BY id").all(key) as Array<Pick<Job, "kind" | "state" | "error">>;
    const prCreate = () => logs.find((l) => l.startsWith("[dry-run] POST /repos/shoutkol/shout/pulls"));
    await waitFor(() => prCreate() !== undefined, 15_000);

    assert.strictEqual(jobs()[0].state, "failed");
    assert.match(jobs()[0].error ?? "", /timed out/);
    const pr = prCreate();
    assert.ok(pr, `no PR was opened; log:\n${logs.join("\n")}`);
    assert.match(pr, /"head":"claude\/WO-444-seeding","base":"dev"/);
    assert.match(pr, /timed out/); // the PR body says why the agent's report is missing
    assert.ok(jobs().some((j) => j.kind === "notion-update"), "the Notion write-back job was not queued");
  } finally {
    console.log = log;
  }
});
