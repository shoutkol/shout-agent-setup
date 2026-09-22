#!/usr/bin/env bash
# End-to-end proof on the GCE Orca desktop for the PR-comment wrapper:
#   worktree on the droplet -> disabled --reuse-session automation -> 2 prompts -> completion detector -> cleanup.
# Creates and removes: one git worktree (repo-wrapper-poc on the droplet), one automation, its terminal.
set -u
export PATH="$HOME/.local/bin:$PATH"
REPO_ID="62e08675-13e7-4ec0-a479-b9742aef62cf"      # shoutkol/shout on the droplet (from gce-inventory.sh)
NAME="wrapper-poc-$(date +%H%M%S)"
j() { python3 -c "import json,sys; d=json.load(sys.stdin); $1" 2>&1; }
p() { printf '\n== %s\n' "$*"; }

p gh identity
gh auth status 2>&1 | grep -iE 'logged in|account|token scopes' ; echo "api user: $(gh api user -q .login 2>&1)"

p create worktree on droplet
CREATE=$(orca worktree create --repo "id:$REPO_ID" --name "$NAME" --no-parent --base-branch dev --json 2>&1)
W=$(echo "$CREATE" | j "print(d['result']['worktree']['id'])")
case "$W" in *Traceback*|*Error*) echo "!! worktree create failed:"; echo "$CREATE" | head -c 1500; exit 1;; esac
echo "worktree id: $W"
echo "$CREATE" | j "w=d['result']['worktree']; print('branch=',w.get('branch'),'host=',w.get('hostId') or w.get('host'),'path=',w.get('path') or w.get('rootPath'))"

p create automation
ID=$(orca automations create --name "$NAME" --trigger daily --time 03:00 \
  --prompt "Remember the secret word PINEAPPLE. Then reply with exactly: OK" \
  --provider claude --workspace "id:$W" --reuse-session --disabled --json 2>&1 | j "print(d['result']['automation']['id'])")
case "$ID" in *Traceback*|*Error*) echo "!! automations create failed: $ID"; orca worktree rm --worktree "id:$W" --json >/dev/null; exit 1;; esac
orca automations show "$ID" --json | j "a=d['result']['automation']; print('id=',a['id'],'reuse=',a['reuseSession'],'mode=',a['workspaceMode'],'target=',a.get('executionTargetType'),a.get('executionTargetId'))"

H=""; RAW_SHOWN=0
wait_done() { # $1 run id  -> the wrapper's completion detector: status=completed AND tui-idle satisfied
  local t0=$(date +%s)
  while :; do
    local EL=$(( $(date +%s)-t0 ))
    read -r ST TAB LEN <<<"$(orca automations runs --id "$ID" --json | j "
x=[x for x in d['result']['runs'] if x['id']=='$1'][0]; s=x.get('outputSnapshot') or {}
print(x['status'], x.get('terminalSessionId') or 'null', len(s.get('content') or ''))")"
    if [ -z "$H" ] && [ "$TAB" != "null" ]; then
      H=$(orca terminal list --worktree "id:$W" --json | j "print(next((t['handle'] for t in d['result']['terminals'] if t.get('tabId')=='$TAB'),''))")
    fi
    IDLE="-"
    if [ -n "$H" ]; then
      RAW=$(orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 4000 --json 2>&1)
      IDLE=$(echo "$RAW" | j "print(d.get('result',{}).get('wait',{}).get('satisfied', 'ok=%s'%d.get('ok')))")
      if [ "$IDLE" != "True" ] && [ $RAW_SHOWN -eq 0 ]; then echo "   (raw terminal wait while busy: $(echo "$RAW" | tr -d '\n' | head -c 300))"; RAW_SHOWN=1; fi
    fi
    printf "   t+%02ds status=%-10s len=%-5s tab=%s idle=%s\n" "$EL" "$ST" "$LEN" "${TAB:0:8}" "$IDLE"
    if [ "$ST" = "completed" ] && [ "$IDLE" = "True" ]; then echo "   -> DONE at t+${EL}s"; return 0; fi
    case "$ST" in failed|cancelled|error) echo "   -> $ST"; return 1;; esac
    [ $EL -gt 300 ] && { echo "   -> TIMEOUT"; return 1; }
    sleep 3
  done
}
show() { orca automations runs --id "$ID" --json | j "
for x in sorted(d['result']['runs'],key=lambda x:x['runNumber']):
    s=x.get('outputSnapshot') or {}; print(f\"   run#{x['runNumber']} {x['status']} tab={str(x.get('terminalSessionId'))[:8]} content={repr((s.get('content') or '')[:200])}\")"; }

p run1
R1=$(orca automations run "$ID" --json | j "print(d['result']['run']['id'])"); wait_done "$R1"; show
p run2 follow-up in same session
orca automations edit "$ID" --prompt "What was the secret word? Also run 'git rev-parse --abbrev-ref HEAD && hostname' and include the output. Reply in one short message." --json >/dev/null
R2=$(orca automations run "$ID" --json | j "print(d['result']['run']['id'])"); wait_done "$R2"; show

p cleanup
orca automations remove "$ID" --json | j "print('   automation removed=',d['result'].get('removed'))"
orca terminal list --worktree "id:$W" --json | j "[print(t['handle']) for t in d['result']['terminals']]" | while read -r h; do orca terminal close --terminal "$h" --json | j "print('   terminal closed ok=',d.get('ok'))"; done
orca worktree rm --worktree "id:$W" --json 2>&1 | j "print('   worktree removed:', json.dumps(d.get('result') or d.get('error'))[:200])"
orca worktree list --json | j "print('   worktrees left:', [w['id'].split('::')[1] for w in d['result'].get('worktrees',[])])"
