#!/usr/bin/env bash
# Stand-in for the orca CLI for a PR job on a session that already has its worktree: the run stays
# "dispatched" with a live agent terminal (handle agent1, tab tab1), and every `terminal send` is
# appended to $SEND_LOG so a test can see what was typed into the agent.
case "$*" in
  *"terminal send"*) echo "$*" >> "$SEND_LOG"; echo '{"ok":true,"result":{"send":{"handle":"agent1"}}}' ;;
  *"terminal list"*) echo '{"ok":true,"result":{"terminals":[{"handle":"agent1","tabId":"tab1","title":"agent"}]}}' ;;
  *"terminal wait"*) echo '{"ok":false,"error":{"code":"timeout","message":"timeout"}}'; exit 1 ;;
  *"automations create"*) echo '{"ok":true,"result":{"automation":{"id":"auto1"}}}' ;;
  *"automations run "*) echo '{"ok":true,"result":{"run":{"id":"run1"}}}' ;;
  *"automations runs"*) echo '{"ok":true,"result":{"runs":[{"id":"run1","runNumber":1,"status":"dispatched","terminalSessionId":"tab1","outputSnapshot":null,"error":null}]}}' ;;
  *) echo '{"ok":true,"result":{"terminals":[]}}' ;;
esac
