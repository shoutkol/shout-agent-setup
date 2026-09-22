#!/usr/bin/env bash
# Stand-in for the orca CLI. Mirrors the real binary's behaviour on a timed-out `terminal wait`:
# JSON envelope with ok:false on stdout AND a non-zero exit code.
case "$*" in
  *"terminal wait"*) echo '{"ok":false,"error":{"code":"timeout","message":"timeout"}}'; exit 1 ;;
  *"terminal close"*) echo '{"ok":false,"error":{"code":"not_found","message":"no such terminal"}}'; exit 1 ;;
  *) echo '{"ok":true,"result":{"terminals":[]}}' ;;
esac
