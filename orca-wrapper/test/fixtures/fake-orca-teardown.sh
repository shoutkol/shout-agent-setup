#!/usr/bin/env bash
# Stand-in for the orca CLI while closing a session. Appends every call to $FAKE_ORCA_LOG. With
# FAKE_ORCA_HANG=1 a terminal's shell never exits (the save step's push failed, say); otherwise
# every one-shot terminal exits at once.
echo "$*" >> "$FAKE_ORCA_LOG"
case "$*" in
  *"repo list"*) echo '{"ok":true,"result":{"repos":[{"id":"r","path":"/srv/base"}]}}' ;;
  *"terminal create"*) echo '{"ok":true,"result":{"terminal":{"handle":"th1"}}}' ;;
  *"--for exit"*)
    if [ -n "$FAKE_ORCA_HANG" ]; then
      echo '{"ok":false,"error":{"code":"timeout","message":"timeout"}}'; exit 1
    fi
    echo '{"ok":true,"result":{"wait":{"satisfied":true}}}' ;;
  *) echo '{"ok":true,"result":{"terminals":[]}}' ;;
esac
