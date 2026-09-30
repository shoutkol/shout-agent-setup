#!/usr/bin/env bash
# Stand-in for the orca CLI through a work order's first run, where the agent never finishes
# within the wrapper's timeout: every git plumbing terminal exits at once, the worktree lands on
# the task's branch, and the automation run stays "dispatched" forever.
case "$*" in
  *"repo list"*) echo '{"ok":true,"result":{"repos":[{"id":"r","path":"/srv/base"}]}}' ;;
  *"worktree create"*) echo '{"ok":true,"result":{"worktree":{"id":"wt1"}}}' ;;
  *"worktree list"*) echo '{"ok":true,"result":{"worktrees":[{"id":"wt1","branch":"refs/heads/claude/WO-444-seeding"}]}}' ;;
  *"terminal create"*) echo '{"ok":true,"result":{"terminal":{"handle":"th1"}}}' ;;
  *"--for exit"*) echo '{"ok":true,"result":{"wait":{"satisfied":true}}}' ;;
  *"terminal wait"*) echo '{"ok":false,"error":{"code":"timeout","message":"timeout"}}'; exit 1 ;;
  *"automations create"*) echo '{"ok":true,"result":{"automation":{"id":"auto1"}}}' ;;
  *"automations run "*) echo '{"ok":true,"result":{"run":{"id":"run1"}}}' ;;
  *"automations runs"*) echo '{"ok":true,"result":{"runs":[{"id":"run1","runNumber":1,"status":"dispatched","terminalSessionId":null,"outputSnapshot":null,"error":null}]}}' ;;
  *) echo '{"ok":true,"result":{"terminals":[]}}' ;;
esac
