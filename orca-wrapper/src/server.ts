// HTTP API. Plain node:http, no framework — all routes JSON, all bearer-authed.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { config } from "./config.ts";
import { openDb, getSessionByPr, getSession, getQueue, getLastOutput, listOpenSessions, taskKey, markRunningJobsFailed } from "./db.ts";
import { createWorker } from "./worker.ts";
import { parseCommand, branchFor, isNotionUrl, isSafeRef, USAGE } from "./logic.ts";
import * as github from "./github.ts";
import * as admin from "./admin.ts";

const WORKER_TICK_MS = 10_000;
const IDLE_SWEEP_MS = 60 * 60 * 1000;

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(config.token);
  if (provided.length !== expected.length) {
    // Still run a constant-time compare (against a same-length dummy) so a wrong-length token
    // doesn't return measurably faster than a right-length one.
    timingSafeEqual(provided, Buffer.alloc(provided.length));
    return false;
  }
  return timingSafeEqual(provided, expected);
}

// A body that isn't JSON is the caller's mistake (400), not ours (500).
class InvalidJson extends Error {}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err: any) {
        reject(new InvalidJson(err?.message ?? "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// `exit` is injectable so tests can exercise the restart routes without killing the test runner.
export function startServer(options: { exit?: (code: number) => void } = {}) {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const db = openDb(config.dbPath);
  const worker = createWorker(db);
  // Startup recovery: jobs left "running" by the last process are failed (never resent) and each
  // PR is told. Fire-and-forget — the notices must not hold up listening.
  const interrupted = markRunningJobsFailed(db);
  if (interrupted.length > 0) {
    void worker.notifyInterrupted(interrupted).catch((err) => console.log(`restart notices failed: ${err}`));
  }

  // Answer first, then exit once the response has gone out — systemd restarts us (see admin.ts).
  function restartAfter(res: ServerResponse): void {
    res.on("finish", () => setTimeout(() => exit(admin.RESTART_EXIT_CODE), 200));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<number> {
    if (!isAuthorized(req)) {
      send(res, 401, { error: "unauthorized" });
      return 401;
    }

    const url = new URL(req.url ?? "/", "http://internal");
    const method = req.method ?? "GET";
    const prMatch = /^\/pr\/(\d+)(\/prompt)?$/.exec(url.pathname);
    const taskMatch = /^\/tasks(?:\/(\d+))?$/.exec(url.pathname);

    if (method === "POST" && prMatch && prMatch[2] === "/prompt") {
      const pr = Number(prMatch[1]);
      const body = await readJson(req);
      const headRef = body?.head_ref;
      const baseRef = body?.base_ref;
      const commentId = body?.comment_id;
      const commentBody = body?.body;
      const author = body?.author;
      if (
        typeof headRef !== "string" ||
        !headRef ||
        typeof baseRef !== "string" ||
        !baseRef ||
        typeof commentId !== "number" ||
        typeof commentBody !== "string" ||
        !commentBody ||
        typeof author !== "string" ||
        !author
      ) {
        send(res, 400, { error: "missing or invalid field" });
        return 400;
      }

      const cmd = parseCommand(commentBody);
      if (!cmd) {
        send(res, 400, { error: "not an /orca command" });
        return 400;
      }
      if (!isSafeRef(headRef)) {
        await github.comment(pr, `🐳 orca: can't work on this PR — its branch name \`${JSON.stringify(headRef)}\` has characters the wrapper won't pass to a shell. Rename the branch to letters, digits, \`.\`, \`_\`, \`-\` and \`/\`.`);
        send(res, 400, { error: "unsupported head_ref" });
        return 400;
      }
      if (cmd.type === "help") {
        await github.comment(pr, USAGE);
        send(res, 202, { help: true });
        return 202;
      }
      if (cmd.type === "stop") {
        // Session may not exist under key `pr-<n>` — it could be a task session whose PR this is.
        // getSessionByPr finds either; when there's truly nothing to close, closeSession no-ops
        // safely on the fallback key. Always 202: an /orca stop comment on a PR with no live
        // session isn't an error from the commenter's point of view.
        const session = getSessionByPr(db, pr);
        const result = await worker.closeSession(session?.key ?? `pr-${pr}`);
        if (result === "closing") {
          await github.comment(pr, "🐳 orca: stopping — the request in progress will finish and post its answer first, then this session closes.");
          send(res, 202, { closing: true });
          return 202;
        }
        send(res, 202, { closed: true });
        return 202;
      }
      if ((await github.pullState(pr)) === "closed") {
        await github.comment(pr, `🐳 orca: PR #${pr} is closed, so there's no session to run this in. Reopen the PR to use /orca again.`);
        send(res, 202, { pr_closed: true });
        return 202;
      }
      const queued = worker.enqueuePrJob(pr, headRef, commentId, author, cmd.prompt);
      if ("rejected" in queued) {
        await github.comment(pr, "🐳 orca: this PR's session is stopping, so this request wasn't queued. Send it again once the current answer is posted.");
        send(res, 202, { rejected: queued.rejected });
        return 202;
      }
      send(res, 202, { job_id: queued.jobId, position: queued.position, ...(queued.deduped ? { deduped: true } : {}) });
      return 202;
    }

    if (method === "GET" && prMatch && !prMatch[2]) {
      const pr = Number(prMatch[1]);
      const session = getSessionByPr(db, pr);
      if (!session) {
        send(res, 404, { error: "not found" });
        return 404;
      }
      send(res, 200, { session, queue: getQueue(db, session.key), last_output: getLastOutput(db, session.key) });
      return 200;
    }

    if (method === "DELETE" && prMatch && !prMatch[2]) {
      const pr = Number(prMatch[1]);
      const session = getSessionByPr(db, pr);
      const closed = session ? await worker.closeSession(session.key) : false;
      if (!closed) {
        send(res, 404, { error: "not found" });
        return 404;
      }
      send(res, 202, { closed: true });
      return 202;
    }

    if (method === "POST" && url.pathname === "/tasks") {
      const body = await readJson(req);
      const notionUrl = body?.notion_url;
      // n8n's Edit Fields node emits strings unless a type is chosen, so "73" and "[\"shout-web\"]"
      // are what a first-draft workflow sends. Coerce the two structured fields rather than 400.
      const wo = typeof body?.wo === "string" && /^\d+$/.test(body.wo) ? Number(body.wo) : body?.wo;
      const title = body?.title;
      // `prompt` is the task's actual first-run instructions to the agent — authored in Notion,
      // passed through verbatim by n8n (see worker.buildPrompt / logic.renderPrompt). Required and
      // non-empty: there is no more hard-coded fallback text to run without it.
      const prompt = body?.prompt;
      if (
        typeof notionUrl !== "string" ||
        !isNotionUrl(notionUrl) ||
        typeof wo !== "number" ||
        !Number.isInteger(wo) ||
        wo <= 0 ||
        typeof title !== "string" ||
        !title.trim() ||
        typeof prompt !== "string" ||
        !prompt.trim()
      ) {
        send(res, 400, { error: "missing or invalid field" });
        return 400;
      }
      const author = typeof body?.author === "string" && body.author ? body.author : "notion";
      let rawRepoApp: unknown = body?.repo_app;
      if (typeof rawRepoApp === "string") {
        try {
          rawRepoApp = JSON.parse(rawRepoApp);
        } catch {
          rawRepoApp = [rawRepoApp];
        }
        if (typeof rawRepoApp === "string") rawRepoApp = [rawRepoApp]; // '"shout-web"' — a JSON string, not a list
      }
      const repoApp: string[] = Array.isArray(rawRepoApp) ? rawRepoApp.filter((x: unknown) => typeof x === "string") : [];

      const branch = branchFor(wo, title);
      const repoAppLine = repoApp.length > 0 ? repoApp.join(", ") : null;
      // Always a 2xx, even for a duplicate or a closing session: n8n only moves the row to
      // Building on success, and both of those mean the work order is already being handled.
      const queued = worker.enqueueTask(wo, notionUrl, title, author, branch, repoAppLine, prompt);
      if ("rejected" in queued) {
        console.log(`task ${queued.key}: POST /tasks while the session is ${queued.rejected}, not queued`);
        send(res, 202, { key: queued.key, rejected: queued.rejected });
        return 202;
      }
      send(res, 202, { key: queued.key, job_id: queued.jobId, position: queued.position, ...(queued.deduped ? { deduped: true } : {}) });
      return 202;
    }

    if (method === "GET" && taskMatch && taskMatch[1]) {
      const key = taskKey(Number(taskMatch[1]));
      const session = getSession(db, key);
      if (!session) {
        send(res, 404, { error: "not found" });
        return 404;
      }
      send(res, 200, { session, queue: getQueue(db, key), last_output: getLastOutput(db, key) });
      return 200;
    }

    if (method === "DELETE" && taskMatch && taskMatch[1]) {
      const key = taskKey(Number(taskMatch[1]));
      const closed = await worker.closeSession(key);
      if (!closed) {
        send(res, 404, { error: "not found" });
        return 404;
      }
      send(res, 202, { closed: true });
      return 202;
    }

    if (method === "GET" && url.pathname === "/admin/health") {
      send(res, 200, await admin.health(db));
      return 200;
    }

    if (method === "GET" && url.pathname === "/admin/logs") {
      try {
        const text = await admin.logs(Number(url.searchParams.get("lines") ?? 200));
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(text);
        return 200;
      } catch (err: any) {
        send(res, 500, { error: `journalctl failed: ${err?.message ?? err}` });
        return 500;
      }
    }

    if (method === "POST" && (url.pathname === "/admin/deploy" || url.pathname === "/admin/restart")) {
      const body = await readJson(req);
      const check = admin.canRestart(db, body?.force === true);
      if (!check.ok) {
        send(res, 409, { error: "jobs are running; retry later or send {\"force\":true}", running: check.running });
        return 409;
      }
      if (url.pathname === "/admin/restart") {
        restartAfter(res);
        send(res, 202, { restarting: true });
        return 202;
      }
      let pulled: { from: string; to: string };
      try {
        pulled = await admin.pullMain();
      } catch (err: any) {
        send(res, 500, { error: `git pull failed, not restarting: ${String(err?.stderr ?? err?.message ?? err).trim()}` });
        return 500;
      }
      restartAfter(res);
      send(res, 202, { ...pulled, restarting: true });
      return 202;
    }

    if (method === "GET" && url.pathname === "/sessions") {
      send(res, 200, listOpenSessions(db));
      return 200;
    }

    send(res, 404, { error: "not found" });
    return 404;
  }

  const server = createServer((req, res) => {
    const start = Date.now();
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    handle(req, res)
      .catch((err) => {
        if (err instanceof InvalidJson) {
          if (!res.headersSent) send(res, 400, { error: "invalid JSON body" });
          return 400;
        }
        console.log(`unhandled error on ${method} ${path}: ${err?.stack ?? err}`);
        if (!res.headersSent) send(res, 500, { error: "internal error" });
        return 500;
      })
      .then((status) => {
        console.log(`${method} ${path} ${status} ${Date.now() - start}ms`);
      });
  });

  server.listen(config.port, "127.0.0.1");

  const tickTimer = setInterval(() => worker.tick(), WORKER_TICK_MS).unref();
  const idleTimer = setInterval(() => worker.sweepIdle(), IDLE_SWEEP_MS).unref();

  function close(): void {
    clearInterval(tickTimer);
    clearInterval(idleTimer);
    server.close();
    db.close();
  }

  return { server, close, db };
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  const { server, close } = startServer();
  server.on("listening", () => {
    console.log(`orca-wrapper listening on ${JSON.stringify(server.address())}`);
  });
  const shutdown = () => {
    close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
