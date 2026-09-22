#!/usr/bin/env bash
# Read-only inventory of the GCE Orca desktop for the PR-comment wrapper. Run as guy_thitiwat, paste the output back.
p() { printf '\n== %s\n' "$*"; }
p host;            echo "$(hostname) / $(id -un) / $(lsb_release -ds 2>/dev/null)"

# The orca CLI is not a binary: it is the app's Electron executable run as node on
# resources/app.asar.unpacked/out/cli/index.js (see Orca.app/Contents/Resources/bin/orca
# on macOS). The Linux build is an AppImage mounted at a fresh /tmp/.mount_orca-XXXXXX on
# every launch, so nothing stable is on PATH. Resolve the mount from the running orca-ide
# process instead -- that also guarantees the CLI matches the running app version.
p orca binary
if ! command -v orca >/dev/null; then
  PID=$(pgrep -o -x orca-ide || pgrep -o -f orca-ide || true)
  if [ -z "$PID" ]; then echo "orca-ide is not running -- start Orca and rerun"; else
    ROOT=$(dirname "$(readlink -f /proc/$PID/exe)")
    echo "orca-ide pid=$PID root=$ROOT"
    echo "AppImage: $(tr '\0' '\n' </proc/$PID/environ 2>/dev/null | grep -E '^APPIMAGE=' || echo '(APPIMAGE env not set)')"
    CLI="$ROOT/resources/app.asar.unpacked/out/cli/index.js"
    if [ -f "$CLI" ]; then
      mkdir -p "$HOME/.local/bin"
      cat > "$HOME/.local/bin/orca" <<'LAUNCHER'
#!/usr/bin/env bash
# orca CLI launcher for the Linux AppImage build: resolves the live mount from the running app.
set -euo pipefail
PID=$(pgrep -o -x orca-ide 2>/dev/null || pgrep -o -f orca-ide 2>/dev/null) || { echo "orca: Orca app is not running" >&2; exit 1; }
ROOT=$(dirname "$(readlink -f /proc/$PID/exe)")
export ORCA_NODE_OPTIONS="${NODE_OPTIONS-}"; unset NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE
ELECTRON_RUN_AS_NODE=1 exec "$ROOT/orca-ide" "$ROOT/resources/app.asar.unpacked/out/cli/index.js" "$@"
LAUNCHER
      chmod +x "$HOME/.local/bin/orca"
      echo "wrote launcher: $HOME/.local/bin/orca"
    else
      echo "cli entry not found at $CLI -- listing resources:"; ls "$ROOT/resources" 2>/dev/null | head -20
      find "$ROOT" -maxdepth 6 -path '*cli*' -name 'index.js' 2>/dev/null | head
    fi
  fi
  export PATH="$HOME/.local/bin:$PATH"
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
