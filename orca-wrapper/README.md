# orca-wrapper

A zero-dependency Node 22 + TypeScript service that lets `/orca <prompt>` PR comments on
`shoutkol/shout` drive a Claude agent session through the Orca desktop app (via
its `orca` CLI). It keeps one live Orca session (worktree + automation) per PR, so follow-up
comments talk to the same agent, and posts the agent's final answer back as a PR comment.

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
2. **One automation run per PR, strictly sequential.** Firing a second `automations run` while one
   is still in flight on the same worktree makes Orca silently fork a second agent session. The
   worker enforces "no running job for this PR" at the DB level before claiming the next queued
   one; different PRs still run concurrently.
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

## API

All routes require `Authorization: Bearer <ORCA_WRAPPER_TOKEN>` (constant-time compare; 401
otherwise). All JSON.

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/pr/{n}/prompt` | `{ head_ref, base_ref, comment_id, body, author }` | 202 `{ job_id, position }`, or 202 `{ closed: true }` if `body` is `/orca stop` |
| `GET` | `/pr/{n}` | — | 200 `{ session, queue, last_output }`, or 404 |
| `GET` | `/sessions` | — | 200, list of open sessions |
| `DELETE` | `/pr/{n}` | — | 202 `{ closed: true }`, or 404 |

`body` must start with `/orca` (the GitHub Actions workflow filters this too, but the server
re-checks — see `parseCommand` in `src/logic.ts`). Unknown routes are 404. Every request logs one
line to stdout: method, path, status, duration.
