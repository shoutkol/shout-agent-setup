# orca-wrapper

A zero-dependency Node 22 + TypeScript service that drives Claude agent sessions through the
Orca desktop app (via its `orca` CLI), from two triggers:

- `/orca <prompt>` PR comments on `shoutkol/shout` — one live Orca session (worktree +
  automation) per PR, so follow-up comments talk to the same agent, with the agent's final answer
  posted back as a PR comment.
- Notion "Agent Work Orders" rows, via `POST /tasks` — one live session per work order, on a new
  branch off `dev`; the wrapper opens the PR itself once the agent has pushed something, and the
  agent writes the PR back onto its Notion row. See [Tasks (Notion work orders)](#tasks-notion-work-orders)
  below.

Every session, whichever way it started, is one row in `sessions` (see `src/db.ts`) — once a
task's PR is open, its session also answers to the `/pr/{n}` routes, so an `/orca ...` comment on
that PR lands in the same agent session as the work order.

Deploy/ops (systemd unit, Caddy, install script, GitHub Actions workflow) is documented in
[`ops/README.md`](ops/README.md) — this file covers only the service itself.

## Env vars

Read once at startup in `src/config.ts`.

| Var | Required | Default | Meaning |
|---|---|---|---|
| `ORCA_WRAPPER_TOKEN` | yes | — | Static bearer token every request must present. |
| `ORCA_REPO_ID` | yes | — | Orca repo id of `shoutkol/shout`. |
| `ORCA_BIN` | no | `${HOME}/.local/bin/orca` | Path to the `orca` CLI launcher. |
| `GITHUB_REPO` | no | `shoutkol/shout` | `owner/name` to post comments/reactions to. |
| `GITHUB_TOKEN` | no | — | If unset, fetched once via `gh auth token`. |
| `GITHUB_DRY_RUN` | no | unset | `1` logs GitHub calls instead of making them (local smoke tests). |
| `PORT` | no | `8787` | Bound to `127.0.0.1` only — Caddy fronts it. |
| `DB_PATH` | no | `${HOME}/.local/share/orca-wrapper/state.sqlite` | SQLite file (dir is created if missing). |
| `IDLE_DAYS` | no | `15` | Sessions idle this long are closed by the hourly sweep. |
| `RUN_TIMEOUT_MIN` | no | `60` | Max time to wait for one automation run to finish. |

On startup `openDb` adds any nullable column the current schema has but the deployed database
lacks (e.g. `sessions.prompt_template`), so a plain update keeps existing sessions. The one change
it can't patch is the old PR-only `sessions`/`jobs` schema (keyed by `pr`) — `openDb` refuses to
start on it, and upgrading past it needs a fresh database: stop the service, `rm
${DB_PATH:-~/.local/share/orca-wrapper}/state.sqlite*`, then restart (see "Update" in
[`ops/README.md`](ops/README.md)). This drops in-flight sessions/jobs, same as any other state
loss — there's nothing to carry forward, since PR numbers and WO numbers aren't reused.

## Run / test

```bash
npm install         # installs the one devDependency: typescript
npm run typecheck    # tsc --noEmit
npm test              # node --test over test/*.test.ts
npm start              # node src/server.ts (needs ORCA_WRAPPER_TOKEN + ORCA_REPO_ID at least)
```

Runs directly with `node src/server.ts` — Node 22.18+ strips TypeScript types natively, so there's
no build step. Source only uses erasable TS syntax (no enums, no namespaces, no parameter
properties) so that stripping is a no-op transform, not a compile.

## The four Orca quirks this wrapper works around

1. **`worktree create` never checks out your branch.** It always creates a *new* branch at the
   base commit. To actually land on the PR's real head branch, we run a throwaway `git fetch &&
   git checkout` in a terminal, then poll `worktree list` until Orca's own `branch` field flips to
   `refs/heads/<head_ref>` — `terminal wait --for exit` does not report the shell exiting, so that
   signal isn't available.
2. **One automation run per session, strictly sequential.** Firing a second `automations run`
   while one is still in flight on the same worktree makes Orca silently fork a second agent
   session. The worker enforces "no running job for this session" at the DB level before claiming
   the next queued one; different sessions (PRs or tasks) still run concurrently.
3. **Completion needs two signals, not one.** An automation run's `status` alone is unreliable: on
   a fresh session it flips to `"completed"` ~3s after dispatch, well before the agent has
   answered, while on a reused session it stays `"dispatched"` until the real end; `tui-idle` alone
   can be true before the prompt was even typed. Only `status === "completed" && tui-idle` matched
   the real answer in every case measured — see `isDone` in `src/logic.ts`. Even then, the first
   output snapshot can be a raw TUI frame that Orca later replaces, so we also wait for
   `outputSnapshot.capturedAt` to repeat on two consecutive polls (`stable` in `src/logic.ts`)
   before trusting the content.
4. **`automations remove` does not close its terminal.** Closing a session removes the automation,
   then separately lists and closes every terminal in the worktree, then removes the worktree —
   each step logged and attempted independently so one failure doesn't skip the rest.

## Images in comments

Pasted images arrive as `https://github.com/user-attachments/assets/<uuid>` links that 404 without
auth on an internal repo, and the agent host has no GitHub credentials. Before each run the wrapper
resolves every such URL to GitHub's short-lived pre-signed S3 URL (one authenticated `GET` with
`redirect: manual`, we only read `Location`), downloads the files on the agent host through a
one-shot `orca terminal create --command "curl …; exit"` into `/tmp/orca-attachments/pr-<n>/`
(outside the checkout, so they can't be committed), and rewrites the prompt to point at those
paths. Max 5 per comment; a failed attachment is logged and left as a URL.

## API

All routes require `Authorization: Bearer <ORCA_WRAPPER_TOKEN>` (constant-time compare; 401
otherwise). All JSON.

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/pr/{n}/prompt` | `{ head_ref, base_ref, comment_id, body, author }` | 202 `{ job_id, position }`, or 202 `{ closed: true }` if `body` is `/orca stop` |
| `GET` | `/pr/{n}` | — | 200 `{ session, queue, last_output }`, or 404 |
| `DELETE` | `/pr/{n}` | — | 202 `{ closed: true }`, or 404 |
| `POST` | `/tasks` | `{ notion_url, wo, title, prompt, author?, repo_app? }` | 202 `{ key, job_id, position }` |
| `GET` | `/tasks/{wo}` | — | 200 `{ session, queue, last_output }`, or 404 |
| `DELETE` | `/tasks/{wo}` | — | 202 `{ closed: true }`, or 404 |
| `GET` | `/sessions` | — | 200, list of open sessions |

`body` on `/pr/{n}/prompt` must start with `/orca` (the GitHub Actions workflow filters this too,
but the server re-checks — see `parseCommand` in `src/logic.ts`). Unknown routes are 404. Every
request logs one line to stdout: method, path, status, duration.

## Tasks (Notion work orders)

The team tracks work in a Notion database "Agent Work Orders". An n8n flow calls `POST /tasks`
when a row's `Stage` becomes `Ready`, and this service runs one agent session per work order —
including reading the Notion page and, at the end, writing the resulting PR back onto it. Notion
property names, verbatim (the running agent needs them exact, since it edits the page itself
through its Notion connector):

| Property | Type | Meaning |
|---|---|---|
| `Stage` | select | `Blocked`, `Ready`, `Building`, `In PR`, `Ready to Test`, `Testing`, `Needs Fix`, `Done` |
| `WO` | auto-increment number | Used in the branch name: `claude/WO-<wo>-<slug>` |
| `Branch` | text | Written by the wrapper's follow-up job once the PR opens |
| `PR` | url | ditto |
| `PR Number` | number | ditto |
| `Last Agent Run` | date | Written by the Dev agent |
| `Repo / App` | multi-select | `shout-web`, `shout-backend`, `shout-ai`, `shout-ffsion` — passed through as `repo_app` and folded into the agent's preamble |

**Session key** is `wo-<wo>` (`src/db.taskKey`). **Branch** is `claude/WO-<wo>-<slug>`, where
`slug` is the title lower-cased, non-ASCII-alnum characters stripped, whitespace collapsed to
single dashes, capped at 40 chars (see `branchFor` in `src/logic.ts`); a title with nothing
sluggable (e.g. all-Thai) yields just `claude/WO-<wo>`. `POST /tasks` on a WO that already has a
live session enqueues that request's own `prompt` as a follow-up job instead of starting a new one
(the session's original `prompt` is not reused or appended).

**`prompt`** is the task's actual first-run instructions to the agent — required, non-empty,
authored in Notion and passed through by n8n exactly as written (there's no more hard-coded
fallback text). Before each run — the first one, or a later follow-up's own `prompt` — it's
rendered through `renderPrompt` in `src/logic.ts`, which substitutes:

| Placeholder | Value |
|---|---|
| `{{branch}}` | the session's branch, `claude/WO-<wo>-<slug>` |
| `{{wo}}` | the work order number |
| `{{title}}` | the Notion page title |
| `{{notion_url}}` | the Notion page URL |
| `{{repo_app}}` | `repo_app`, comma-joined, or empty |

An unrecognised `{{...}}` is left untouched rather than blanked. The first run's `prompt` is also
kept on the session as `prompt_template` (`src/db.ts`) for reference; the auto-generated
Notion-writeback job (below) keeps its own hard-coded prompt and is never rendered.

**Two-run flow**, driven from `worker.ts` — unchanged except for where the first prompt comes from:

1. The wrapper creates a fresh worktree, force-creates the branch off `origin/dev`, and pushes it
   immediately (before the agent runs at all) so the branch always exists on origin. The agent is
   told, via the rendered `prompt`, to read the Notion page as its spec, implement it, and always
   `git push` before finishing — even if blocked, so the PR is where open questions get discussed.
2. Once that run completes, the wrapper checks `GET /repos/{repo}/compare/dev...<branch>`. If
   `ahead_by === 0` (the agent pushed nothing), no PR is opened — the job is just marked done, and
   a later `POST /tasks` can pick the session back up. Otherwise the wrapper opens the PR itself
   (`base: dev`, not a draft, body = `Notion: <url>` + the agent's own output, since that's where
   its open questions live) and enqueues one more job in the same session asking the agent to
   write `PR`, `PR Number`, `Branch`, `Stage: In PR`, and `Last Agent Run` back onto the Notion
   page. That job's output is logged, not posted anywhere, since there's no PR comment for it yet
   the first time around.

From then on the session behaves like a PR session: further task runs, or `/orca ...` comments on
the now-open PR (same session, found via `getSessionByPr`), post their output as a PR comment.
