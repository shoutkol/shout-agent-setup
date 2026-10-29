#!/usr/bin/env bash
# Stand-in for the orca CLI in release-notes.test.ts: one connected host, every call appended to
# $FAKE_ORCA_LOG, one-shot terminals exit at once, and `worktree create` fails — far enough for a
# test to see which ref a new session fetches, and (on a session that already has a worktree) the
# prompt handed to `automations create`, without any job ever running.
echo "$*" >> "$FAKE_ORCA_LOG"
case "$*" in
  *"host list"*) echo '{"ok":true,"result":{"hosts":[{"kind":"ssh","id":"ssh-1","connected":true}]}}' ;;
  *"repo list"*) echo '{"ok":true,"result":{"repos":[{"id":"r","path":"/srv/base","executionHostId":"ssh:ssh-1"}]}}' ;;
  *"terminal create"*) echo '{"ok":true,"result":{"terminal":{"handle":"th1"}}}' ;;
  *"--for exit"*) echo '{"ok":true,"result":{"wait":{"satisfied":true}}}' ;;
  *"worktree create"*|*"automations create"*) echo '{"ok":false,"error":{"code":"fake","message":"fake orca"}}'; exit 1 ;;
  *) echo '{"ok":true,"result":{"terminals":[]}}' ;;
esac
