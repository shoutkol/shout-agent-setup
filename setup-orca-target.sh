#!/usr/bin/env bash
# =============================================================================
#  Ubuntu host -> Orca remote SSH worktree target
#
#  Makes an existing Ubuntu box (GCE desktop VM, DigitalOcean droplet, bare
#  metal) able to host Orca worktrees: git worktrees are created here, agents
#  run here, and your laptop only streams the editor/diff/terminal.
#
#  Run as a NORMAL user (not root, not sudo):
#      bash setup-orca-target.sh --repo shoutkol/shout
#
#  Idempotent: safe to re-run.
#
#  Options:
#      --repo OWNER/NAME    clone this GitHub repo (default: skip cloning)
#      --dest PATH          where to clone      (default: $HOME/<name>)
#      --git-name NAME      git user.name       (default: keep existing)
#      --git-email EMAIL    git user.email      (default: keep existing)
#      --key NAME           ssh key filename    (default: github)
# =============================================================================
set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "!! Run this as a normal user, not root/sudo. The script calls sudo itself."
  echo "   Orca runs agents as the SSH user, so everything must belong to that user."
  exit 1
fi

trap 'echo -e "\n\033[1;31m!! FAILED at line $LINENO\033[0m"; exit 1' ERR

REPO=""
DEST=""
GIT_NAME=""
GIT_EMAIL=""
KEY_NAME="github"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)      REPO="$2";      shift 2 ;;
    --dest)      DEST="$2";      shift 2 ;;
    --git-name)  GIT_NAME="$2";  shift 2 ;;
    --git-email) GIT_EMAIL="$2"; shift 2 ;;
    --key)       KEY_NAME="$2";  shift 2 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "!! Unknown option: $1"; exit 1 ;;
  esac
done

USER_NAME="$(id -un)"
KEY_PATH="$HOME/.ssh/$KEY_NAME"
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive
# Ubuntu 22.04+ ships needrestart in interactive mode: it stops mid-install to
# ask which daemons to bounce, which hangs an otherwise unattended run. 'a' =
# restart automatically, and the suspend flag keeps it from touching ssh.service
# out from under the connection running this script.
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# -----------------------------------------------------------------------------
log "1/6  Host requirements (git + build toolchain)"
# -----------------------------------------------------------------------------
# git      -> Orca runs `git worktree add` over SSH
# make/g++ -> node-pty builds here; without them Orca still connects for files,
#             git and the editor, but REMOTE TERMINALS SILENTLY DO NOT WORK.
#             That failure looks like an Orca bug and is not.
# python3  -> node-gyp
sudo apt-get update -qq
sudo apt-get install -y -qq git build-essential python3 curl rsync ca-certificates gnupg

# -----------------------------------------------------------------------------
log "2/6  Node.js 22 (system-wide)"
# -----------------------------------------------------------------------------
# System-wide on purpose. Orca launches agents over NON-INTERACTIVE ssh, which
# does not source ~/.bashrc -- so nvm/fnm-managed node is invisible there and
# the agent binary "disappears" the moment Orca tries to spawn it.
# Probe the SYSTEM node, not whatever nvm/fnm has shimmed into this shell.
# A user-level node 24 satisfies `node -v` here and still leaves `sudo npm`
# with "command not found" -- and leaves Orca's non-interactive SSH with no
# node at all.
sys_node() { env -i PATH=/usr/local/bin:/usr/bin:/bin sh -c 'command -v node' 2>/dev/null; }
SYS_NODE="$(sys_node || true)"
NODE_MAJOR=0
[[ -n "$SYS_NODE" ]] && NODE_MAJOR="$("$SYS_NODE" -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"

if [[ "${NODE_MAJOR:-0}" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
  if [[ -n "$(command -v node)" && "$(command -v node)" != "$(sys_node)" ]]; then
    echo "   note: your shell still resolves node via $(command -v node) (nvm/fnm)."
    echo "         That is fine -- Orca and sudo will use $(sys_node)."
  fi
else
  echo "   system node $("$SYS_NODE" -v) already present, keeping it"
fi

# npm's global prefix is root-owned; keep using sudo rather than chown-ing it,
# so a later `apt upgrade nodejs` does not fight with hand-edited permissions.
# Same trap as node: a claude installed under nvm satisfies `command -v claude`
# in this shell and is invisible to Orca's non-interactive SSH.
sys_claude() { env -i PATH=/usr/local/bin:/usr/bin:/bin sh -c 'command -v claude' 2>/dev/null; }

if [[ -z "$(sys_claude || true)" ]]; then
  sudo npm install -g @anthropic-ai/claude-code
fi

if [[ -n "$(sys_claude || true)" ]]; then
  echo "   claude $("$(sys_claude)" --version 2>/dev/null) at $(sys_claude)"
else
  echo "   !! 'claude' is not on the default non-interactive PATH."
  echo "      Orca will fail to launch the agent. Check where it installed:"
  echo "        npm root -g"
fi

# -----------------------------------------------------------------------------
log "3/6  Git identity"
# -----------------------------------------------------------------------------
# Commits are authored by whoever this host says it is -- set it to the agent
# account, not your personal one, or every agent commit lands under your name.
[[ -n "$GIT_NAME"  ]] && git config --global user.name  "$GIT_NAME"
[[ -n "$GIT_EMAIL" ]] && git config --global user.email "$GIT_EMAIL"

CUR_NAME="$(git config --global user.name  || true)"
CUR_EMAIL="$(git config --global user.email || true)"
if [[ -z "$CUR_NAME" || -z "$CUR_EMAIL" ]]; then
  echo "   !! No git identity set. Agent commits will be rejected or misattributed."
  echo "      Re-run with:  --git-name 'pm607' --git-email 'ID+pm607@users.noreply.github.com'"
else
  echo "   $CUR_NAME <$CUR_EMAIL>"
fi

# -----------------------------------------------------------------------------
log "4/6  GitHub SSH key for this host"
# -----------------------------------------------------------------------------
# The host pushes on its own key, not through agent-forwarding: forwarded
# agents die when your laptop sleeps, which is exactly the case Orca exists to
# survive.
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"

if [[ ! -f "$KEY_PATH" ]]; then
  ssh-keygen -t ed25519 -N "" -f "$KEY_PATH" -C "orca-$(hostname -s)" >/dev/null
  echo "   generated $KEY_PATH"
else
  echo "   $KEY_PATH already exists, reusing"
fi

if ! grep -q "IdentityFile ~/.ssh/$KEY_NAME" "$HOME/.ssh/config" 2>/dev/null; then
  printf 'Host github.com\n  IdentityFile ~/.ssh/%s\n  IdentitiesOnly yes\n' "$KEY_NAME" \
    >> "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"
fi

GH_USER="$(ssh -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 \
           | sed -n 's/^Hi \([^!]*\)!.*/\1/p' || true)"

if [[ -z "$GH_USER" ]]; then
  cat <<KEY

   This key is not on any GitHub account yet. Add it, then re-run:

     https://github.com/settings/keys  ->  New SSH key

$(cat "$KEY_PATH.pub")

   A key can live on only ONE GitHub account. If it is already attached to
   your personal account, delete it there first, then add it to the agent
   account -- otherwise the agent commits and pushes as you.
KEY
else
  echo "   authenticates to GitHub as: $GH_USER"
fi

# -----------------------------------------------------------------------------
log "5/6  Claude Code authentication"
# -----------------------------------------------------------------------------
# Claude DESKTOP being signed in does not authenticate the Claude CODE CLI --
# they keep separate credentials. Orca launches the CLI.
if [[ -f "$HOME/.claude/.credentials.json" ]] || \
   grep -qs '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null; then
  echo "   Claude Code CLI is already signed in for $USER_NAME"
else
  echo "   !! Claude Code CLI is NOT signed in for $USER_NAME."
  echo "      Signing in to Claude Desktop does not cover the CLI."
  echo "      Run this once, interactively, then /exit:"
  echo "        claude"
fi

# -----------------------------------------------------------------------------
log "6/6  Repository"
# -----------------------------------------------------------------------------
if [[ -n "$REPO" ]]; then
  [[ -z "$DEST" ]] && DEST="$HOME/${REPO##*/}"
  if [[ -d "$DEST/.git" ]]; then
    echo "   $DEST already a git repo, skipping clone"
  else
    git clone "git@github.com:${REPO}.git" "$DEST"
  fi
  echo "   repo path for Orca:  $DEST"
else
  DEST="<clone a repo first>"
  echo "   skipped (no --repo given)"
fi

# =============================================================================
IP="$(curl -fsS --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"

cat <<BANNER

=============================================================================
  Host is ready as an Orca SSH target.

  user      $USER_NAME
  host      $(hostname -s)  ($IP)
  repo      $DEST

  ---------------------------------------------------------------------------
  NOW ON YOUR LAPTOP
  ---------------------------------------------------------------------------

  GCE VMs: let gcloud write the SSH config entry for you --

    gcloud compute config-ssh

  That adds a host named <instance>.<zone>.<project> using
  ~/.ssh/google_compute_engine. Re-run it after any stop/start: the entry
  pins the ephemeral external IP, which changes. Reserve a static IP if you
  stop the VM often.

  If the VM has no external IP (IAP only), add the tunnel by hand instead:

    Host orca-gce
        HostName    <instance-name>
        User        $USER_NAME
        IdentityFile ~/.ssh/google_compute_engine
        ProxyCommand gcloud compute start-iap-tunnel %h %p \\
                       --listen-on-stdin --zone=<zone> --project=<project>
        ServerAliveInterval 30
        ServerAliveCountMax 6

  Verify BEFORE touching Orca -- Orca cannot fix a broken ssh config:

    ssh <host> "hostname && git --version && claude --version"

  Then in Orca:
    1. Settings -> SSH -> Add Target -> import from the OpenSSH config picker
    2. Test  ->  Connect
    3. Add repo -> pick the SSH target -> $DEST
    4. Create a worktree, launch an agent
    5. In the worktree terminal run:  hostname && pwd
       It must print this host. Your laptop's hostname means the worktree
       was created locally.

  Note: OS Login (enable-oslogin=TRUE) renames the SSH user to
  your_email_domain_com. If that is on, the account Orca logs in as is NOT
  "$USER_NAME", and none of the setup above applies to it -- re-run this
  script as that user.
=============================================================================

BANNER
