// HTTP API. Plain node:http, no framework — all routes JSON, all bearer-authed.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { config } from "./config.ts";
import { openDb, getSessionByPr, getSession, getQueue, getLastOutput, listOpenSessions, taskKey } from "./db.ts";
import { createWorker } from "./worker.ts";
import { parseCommand, branchFor, isNotionUrl } from "./logic.ts";

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

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startServer() {
  const db = openDb(config.dbPath); // also runs the "running job -> failed" startup recovery
  const worker = createWorker(db);

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
      if (cmd.type === "stop") {
        // Session may not exist under key `pr-<n>` — it could be a task session whose PR this is.
        // getSessionByPr finds either; when there's truly nothing to close, closeSession no-ops
        // safely on the fallback key. Always 202: an /orca stop comment on a PR with no live
        // session isn't an error from the commenter's point of view.
        const session = getSessionByPr(db, pr);
        await worker.closeSession(session?.key ?? `pr-${pr}`);
        send(res, 202, { closed: true });
        return 202;
      }
      const { jobId, position } = worker.enqueuePrJob(pr, headRef, commentId, author, cmd.prompt);
      send(res, 202, { job_id: jobId, position });
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
      if (
        typeof notionUrl !== "string" ||
        !isNotionUrl(notionUrl) ||
        typeof wo !== "number" ||
        !Number.isInteger(wo) ||
        wo <= 0 ||
        typeof title !== "string" ||
        !title.trim()
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
      }
      const repoApp: string[] = Array.isArray(rawRepoApp) ? rawRepoApp.filter((x: unknown) => typeof x === "string") : [];
      const prompt = typeof body?.prompt === "string" ? body.prompt : undefined;

      const branch = branchFor(wo, title);
      const repoAppLine = repoApp.length > 0 ? repoApp.join(", ") : null;
      const { key, jobId, position } = worker.enqueueTask(wo, notionUrl, title, author, branch, repoAppLine, prompt);
      send(res, 202, { key, job_id: jobId, position });
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

  return { server, close };
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
