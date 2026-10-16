#!/usr/bin/env bash
# Stand-in for the orca CLI when Claude has quit in the session's terminal: every automation run
# ends "failed" with error terminal_exited. Logs each call to $FAKE_ORCA_LOG.
echo "$*" >> "$FAKE_ORCA_LOG"
case "$*" in
  *"terminal wait"*) echo '{"ok":true,"result":{"wait":{"satisfied":true}}}' ;;
  *"automations run "*) echo '{"ok":true,"result":{"run":{"id":"run1"}}}' ;;
  *"automations runs"*) echo '{"ok":true,"result":{"runs":[{"id":"run1","runNumber":1,"status":"failed","terminalSessionId":null,"outputSnapshot":null,"error":"terminal_exited"}]}}' ;;
  *) echo '{"ok":true,"result":{}}' ;;
esac
