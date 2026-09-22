#!/usr/bin/env bash
# Read-only inventory of the GCE Orca desktop for the PR-comment wrapper. Run as guy_thitiwat, paste the output back.
p() { printf '\n== %s\n' "$*"; }
p host;            echo "$(hostname) / $(id -un) / $(lsb_release -ds 2>/dev/null)"

# The orca CLI ships inside the app (macOS: Orca.app/Contents/Resources/bin/orca) and is
# not on PATH until the app's "install CLI" step runs. Find it wherever the Linux build put it.
p orca binary
if ! command -v orca >/dev/null; then
  PID=$(pgrep -o -x orca-ide || pgrep -o -f orca-ide || true)
  [ -n "$PID" ] && echo "orca-ide pid=$PID exe=$(readlink -f /proc/$PID/exe 2>/dev/null)"
  CANDS=$(
    [ -n "$PID" ] && APPDIR=$(dirname "$(readlink -f /proc/$PID/exe 2>/dev/null)") && ls -d "$APPDIR"/resources/bin/orca "$APPDIR"/resources/app/bin/orca "$APPDIR"/bin/orca 2>/dev/null
    find /opt /usr/share /usr/lib /usr/local "$HOME/.local" "$HOME/Applications" /snap -maxdepth 7 -type f -name orca 2>/dev/null
  )
  echo "candidates:"; echo "$CANDS" | sed 's/^/  /'
  FIRST=$(echo "$CANDS" | grep -m1 .)
  [ -n "$FIRST" ] && export PATH="$(dirname "$FIRST"):$PATH" && echo "using: $FIRST"
fi
command -v orca && orca --version || echo "orca CLI still not found"

j() { python3 -c "import json,sys; d=json.load(sys.stdin); $1" 2>&1 | head -40; }
p orca status;     orca status --json 2>&1 | j "r=d['result']; print('app.running=',r['app']['running'],'runtime=',r['runtime']['state'],'appVersion=',r['runtime'].get('appVersion'))"
p orca environments; orca environment list --json 2>&1 | head -c 1500; echo
p orca repos;      orca repo list --json 2>&1 | j "
r=d['result']; items=r.get('repos') or r.get('repositories') or r
for x in (items if isinstance(items,list) else []): print(' ', x.get('id'), '|', x.get('path') or x.get('rootPath'), '| host=', x.get('hostId') or x.get('host'))"
p orca projects;   orca project list --json 2>&1 | head -c 2500; echo
p orca worktrees;  orca worktree list --json 2>&1 | j "
r=d['result']
for w in r.get('worktrees',[])[:15]: print(' ', w.get('id'), '| branch=', w.get('branch'), '| host=', w.get('hostId') or w.get('host'))
print(' scope:', r.get('scope'))"
p orca automations; orca automations list --json 2>&1 | j "[print(' ',a['name'],'enabled=',a['enabled'],'host=',a.get('executionTargetId')) for a in d['result']['automations']]"
p gh;              command -v gh && gh --version | head -1 && gh auth status 2>&1 | grep -iE 'logged in|account|token scopes|not logged' ; git config --global user.name; git config --global user.email
p node;            echo "shell node: $(command -v node) $(node -v 2>&1)"; echo "system node: $(ls /usr/bin/node /usr/local/bin/node 2>/dev/null | head -1) $(/usr/bin/node -v 2>&1 || /usr/local/bin/node -v 2>&1)"
p caddy / ports;   command -v caddy || echo "caddy: none"; (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | awk 'NR==1||/LISTEN/' | head -15
p public ip;       curl -s --max-time 5 ifconfig.me; echo
p systemd user;    systemctl --user list-units --type=service --state=running --no-pager 2>/dev/null | grep -viE 'gvfs|pipewire|pulseaudio|dbus|dconf|at-spi|gpg-agent|gnome-terminal' | head -8
