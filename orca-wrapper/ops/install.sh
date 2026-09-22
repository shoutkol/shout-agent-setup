#!/usr/bin/env bash
# =============================================================================
#  orca-wrapper -- install and start the PR-comment wrapper
#
#  Sets up the systemd --user service, the Caddy reverse proxy (with a real
#  TLS cert), and local config for orca-wrapper on this GCE desktop VM.
#
#  orca-wrapper MUST run as THIS user's systemd --user service, not a system
#  service: it shells out to the `orca` CLI, which only works while the Orca
#  desktop app is running inside this user's graphical session.
#
#  Run as a NORMAL user (not root, not sudo):
#      bash install.sh
#
#  Idempotent: safe to re-run.
#
#  Options:
#      --app-dir PATH   orca-wrapper checkout  (default: $HOME/shout-agent-setup/orca-wrapper)
#      --domain NAME    public hostname        (default: orca.shouttgt.com)
# =============================================================================
set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "!! Run this as a normal user, not root/sudo. The script calls sudo itself."
  echo "   orca-wrapper runs as a systemd --user service under this account."
  exit 1
fi

trap 'echo -e "\n\033[1;31m!! FAILED at line $LINENO\033[0m"; exit 1' ERR

APP_DIR="$HOME/shout-agent-setup/orca-wrapper"
DOMAIN="orca.shouttgt.com"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --domain)  DOMAIN="$2";  shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "!! Unknown option: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"
CONFIG_DIR="$HOME/.config/orca-wrapper"
ENV_FILE="$CONFIG_DIR/env"
UNIT_DIR="$HOME/.config/systemd/user"
ORCA_BIN_PATH="$HOME/.local/bin/orca"
DEFAULT_APP_DIR="$HOME/shout-agent-setup/orca-wrapper"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); $1" 2>/dev/null; }

export DEBIAN_FRONTEND=noninteractive
# Ubuntu 22.04+ ships needrestart in interactive mode: it stops mid-install to
# ask which daemons to bounce, which hangs an otherwise unattended run.
export NEEDRESTART_MODE=a

# -----------------------------------------------------------------------------
log "1/9  System node.js"
# -----------------------------------------------------------------------------
# The unit hardcodes /usr/bin/node (see orca-wrapper.service): systemd --user
# does not source ~/.bashrc, so nvm's node is invisible to it even though it
# satisfies `node -v` in an interactive shell.
if [[ ! -x /usr/bin/node ]]; then
  echo "!! /usr/bin/node not found. Run setup-orca-target.sh first (installs Node 22 system-wide)."
  exit 1
fi
NODE_VER="$(/usr/bin/node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 18) )); then
  echo "!! /usr/bin/node is v$NODE_VER, need >= 22.18. Run setup-orca-target.sh to update it."
  exit 1
fi
echo "   /usr/bin/node v$NODE_VER"

# -----------------------------------------------------------------------------
log "2/9  Orca desktop app + CLI launcher"
# -----------------------------------------------------------------------------
# orca-wrapper shells out to this launcher, which only answers while the Orca
# desktop app is running in this user's graphical session.
if [[ ! -x "$ORCA_BIN_PATH" ]]; then
  echo "!! $ORCA_BIN_PATH not found."
  echo "   Run gce-inventory.sh once (it writes this launcher), then start Orca, then re-run."
  exit 1
fi
ORCA_STATUS="$("$ORCA_BIN_PATH" status --json 2>&1)" || true
RUNNING="$(echo "$ORCA_STATUS" | j "print(d['result']['app']['running'])")"
if [[ "$RUNNING" != "True" ]]; then
  echo "!! Orca does not report the app as running:"
  echo "$ORCA_STATUS" | head -c 500; echo
  echo "   Start the Orca desktop app in this session (re-run gce-inventory.sh if the launcher"
  echo "   itself looks stale -- it re-resolves against whatever app instance is live), then re-run."
  exit 1
fi
echo "   orca app running"

# -----------------------------------------------------------------------------
log "3/9  GitHub CLI auth"
# -----------------------------------------------------------------------------
# GITHUB_TOKEN falls back to `gh auth token` at runtime, and this script uses
# gh itself below to look up the repo id.
if ! gh auth status >/dev/null 2>&1; then
  echo "!! 'gh auth status' failed. Run 'gh auth login' as $USER_NAME, then re-run."
  exit 1
fi
echo "   gh authenticated as $(gh api user -q .login 2>/dev/null || echo '?')"

# -----------------------------------------------------------------------------
log "4/9  Caddy (system-wide, official apt repo)"
# -----------------------------------------------------------------------------
# Caddy needs root to bind :443 and auto-provision the Let's Encrypt cert, so
# unlike orca-wrapper it is an ordinary system service, installed via apt.
# Steps per https://caddyserver.com/docs/install#debian-ubuntu-raspbian
if ! command -v caddy >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
else
  echo "   caddy $(caddy version) already installed"
fi

# -----------------------------------------------------------------------------
log "5/9  Caddyfile"
# -----------------------------------------------------------------------------
CADDYFILE_SRC="$SCRIPT_DIR/Caddyfile"
CADDYFILE_DST="/etc/caddy/Caddyfile"
TMP_CADDYFILE="$(mktemp)"
trap 'rm -f "$TMP_CADDYFILE"' EXIT

if [[ "$DOMAIN" != "orca.shouttgt.com" ]]; then
  sed "s/^orca\.shouttgt\.com {/${DOMAIN} {/" "$CADDYFILE_SRC" > "$TMP_CADDYFILE"
else
  cp "$CADDYFILE_SRC" "$TMP_CADDYFILE"
fi

sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy 2>/dev/null || true

if [[ -f "$CADDYFILE_DST" ]] && ! cmp -s "$TMP_CADDYFILE" "$CADDYFILE_DST"; then
  sudo cp "$CADDYFILE_DST" "$CADDYFILE_DST.bak"
  echo "   existing $CADDYFILE_DST differs, backed it up to $CADDYFILE_DST.bak"
fi
sudo cp "$TMP_CADDYFILE" "$CADDYFILE_DST"
sudo systemctl reload-or-restart caddy
echo "   installed $CADDYFILE_DST for $DOMAIN, reloaded caddy"

# -----------------------------------------------------------------------------
log "6/9  orca-wrapper config (~/.config/orca-wrapper/env)"
# -----------------------------------------------------------------------------
mkdir -p "$CONFIG_DIR"
TOKEN=""
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SCRIPT_DIR/env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  TOKEN="$(openssl rand -hex 32)"
  sed -i "s|^ORCA_WRAPPER_TOKEN=.*|ORCA_WRAPPER_TOKEN=$TOKEN|" "$ENV_FILE"
  echo "   generated ORCA_WRAPPER_TOKEN"

  REPOS_JSON="$("$ORCA_BIN_PATH" repo list --json 2>&1)" || true
  REPO_COUNT="$(echo "$REPOS_JSON" \
    | j "items=d['result'].get('repos') or d['result'].get('repositories') or d['result']; print(len(items) if isinstance(items, list) else 0)")"
  REPO_COUNT="${REPO_COUNT:-0}"
  if [[ "$REPO_COUNT" == "1" ]]; then
    REPO_ID="$(echo "$REPOS_JSON" \
      | j "items=d['result'].get('repos') or d['result'].get('repositories') or d['result']; print(items[0]['id'])")"
    if [[ -n "$REPO_ID" ]]; then
      sed -i "s|^ORCA_REPO_ID=.*|ORCA_REPO_ID=$REPO_ID|" "$ENV_FILE"
      echo "   auto-filled ORCA_REPO_ID=$REPO_ID (the only repo Orca knows about)"
    fi
  else
    echo "   !! Orca reports $REPO_COUNT repos, not exactly one -- leaving ORCA_REPO_ID blank."
    echo "      Fill it in yourself in $ENV_FILE from: orca repo list --json"
  fi
  echo "   wrote $ENV_FILE (mode 600)"
else
  echo "   $ENV_FILE already exists, leaving it alone"
fi

# -----------------------------------------------------------------------------
log "7/9  Linger (keep the user service manager alive after logout)"
# -----------------------------------------------------------------------------
# Without this, systemd --user (and orca-wrapper with it) is torn down the
# moment the session that started it ends -- exactly the case this exists to
# survive, since Orca itself runs in a graphical session that isn't always
# an active SSH login.
if [[ "$(loginctl show-user "$USER_NAME" --property=Linger --value 2>/dev/null)" != "yes" ]]; then
  sudo loginctl enable-linger "$USER_NAME"
fi
echo "   linger enabled for $USER_NAME"

# -----------------------------------------------------------------------------
log "8/9  systemd --user unit"
# -----------------------------------------------------------------------------
mkdir -p "$UNIT_DIR"
UNIT_SRC="$SCRIPT_DIR/orca-wrapper.service"
UNIT_DST="$UNIT_DIR/orca-wrapper.service"

if [[ "$APP_DIR" == "$DEFAULT_APP_DIR" ]]; then
  cp "$UNIT_SRC" "$UNIT_DST"
else
  # %h only expands to $HOME at systemd's runtime, so a custom --app-dir has
  # to be baked in as a literal path here instead.
  sed "s|%h/shout-agent-setup/orca-wrapper|$APP_DIR|g" "$UNIT_SRC" > "$UNIT_DST"
fi

if [[ ! -f "$APP_DIR/src/server.ts" ]]; then
  echo "   !! $APP_DIR/src/server.ts not found yet -- the service will fail to start until it exists."
fi

systemctl --user daemon-reload
systemctl --user enable --now orca-wrapper
echo "   orca-wrapper enabled and started"

# -----------------------------------------------------------------------------
log "9/9  Smoke test"
# -----------------------------------------------------------------------------
# PORT is commented out in env.example, so this grep normally matches nothing -- and a no-match
# grep exits 1, which under pipefail + the ERR trap would abort the whole install right here.
PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)"
PORT="${PORT:-8787}"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(grep -E '^ORCA_WRAPPER_TOKEN=' "$ENV_FILE" | cut -d= -f2 || true)"
fi

SMOKE=""
for _ in 1 2 3 4 5; do
  if SMOKE="$(curl -fsS "http://127.0.0.1:$PORT/sessions" -H "Authorization: Bearer $TOKEN" 2>&1)"; then
    break
  fi
  SMOKE=""
  sleep 1
done
if [[ -z "$SMOKE" ]]; then
  echo "!! smoke test failed (GET /sessions). Recent logs:"
  journalctl --user -u orca-wrapper -n 30 --no-pager || true
  exit 1
fi
echo "   GET /sessions -> $SMOKE"

# =============================================================================
cat <<BANNER

=============================================================================
  orca-wrapper is running locally on this VM. Three things left that this
  script cannot do for you:

  ---------------------------------------------------------------------------
  1. DNS
  ---------------------------------------------------------------------------
  Point the domain at this VM's external IP:

    $DOMAIN   A   34.21.243.182

  ---------------------------------------------------------------------------
  2. Firewall: open tcp:443           (run from wherever you run gcloud)
  ---------------------------------------------------------------------------
  Only port 22 is open on this VM today.

    gcloud compute instances add-tags p-m-shouttgt-agent \\
      --zone=<zone> --tags=orca-wrapper-https

    gcloud compute firewall-rules create allow-orca-wrapper-https \\
      --network=default --direction=INGRESS --action=ALLOW \\
      --rules=tcp:443 --target-tags=orca-wrapper-https \\
      --source-ranges=0.0.0.0/0

  ---------------------------------------------------------------------------
  3. GitHub repo secrets   (shoutkol/shout -> Settings -> Secrets -> Actions)
  ---------------------------------------------------------------------------
    ORCA_WRAPPER_URL     = https://$DOMAIN
    ORCA_WRAPPER_TOKEN   = $TOKEN

  Also copy orca-wrapper/ops/github-workflow.yml into shoutkol/shout as
  .github/workflows/orca.yml -- see ops/README.md.

  Caddy issues its Let's Encrypt cert on the first real HTTPS request once
  DNS and the firewall rule are both live -- no separate step for that.
=============================================================================

BANNER
