#!/usr/bin/env bash
# Stand-in for the orca CLI. Mirrors the real binary's behaviour on a timed-out `terminal wait`:
# JSON envelope with ok:false on stdout AND a non-zero exit code.
case "$*" in
  *"terminal wait"*) echo '{"ok":false,"error":{"code":"timeout","message":"timeout"}}'; exit 1 ;;
  *"terminal close"*) echo '{"ok":false,"error":{"code":"not_found","message":"no such terminal"}}'; exit 1 ;;
  *"repo list"*) echo '{"ok":true,"result":{"repos":[{"id":"r","path":"/srv/base","executionHostId":"ssh:ssh-1"},{"id":"r2","path":"/srv/base","executionHostId":"ssh:ssh-2"}]}}' ;;
  *"host list"*) echo '{"ok":true,"result":{"hosts":[{"kind":"local","id":"local","connected":true},{"kind":"ssh","id":"ssh-1","connected":true},{"kind":"ssh","id":"ssh-2","connected":false}]}}' ;;
  *"worktree list"*) echo '{"ok":true,"result":{"worktrees":[{"id":"r::/srv/base","branch":"refs/heads/main"},{"id":"r::/srv/wt1","branch":"refs/heads/x"},{"id":"r2::/srv/wt2","branch":"refs/heads/y"}]}}' ;;
  *) echo '{"ok":true,"result":{"terminals":[]}}' ;;
esac
