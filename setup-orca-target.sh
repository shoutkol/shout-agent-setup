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
#
#  Also installs the memory guards (earlyoom, hourly claude-reaper, 8G swap)
#  and the QA tooling (gh, agent-browser + Chrome), so every host the wrapper
#  can place a session on is interchangeable.
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
    -h|--help)   sed -n "2,24p" "$0"; exit 0 ;;
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
log "1/8  Host requirements (git + build toolchain)"
# -----------------------------------------------------------------------------
# git      -> Orca runs `git worktree add` over SSH
# make/g++ -> node-pty builds here; without them Orca still connects for files,
#             git and the editor, but REMOTE TERMINALS SILENTLY DO NOT WORK.
#             That failure looks like an Orca bug and is not.
# python3  -> node-gyp
sudo apt-get update -qq
sudo apt-get install -y -qq git build-essential python3 curl rsync ca-certificates gnupg

# -----------------------------------------------------------------------------
log "2/8  Node.js 22 (system-wide)"
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
log "3/8  Git identity"
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
log "4/8  GitHub SSH key for this host"
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
log "5/8  Claude Code authentication"
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
log "6/8  Memory guards (earlyoom + claude-reaper + swap)"
# -----------------------------------------------------------------------------
# Every Orca terminal tab keeps a `claude` TUI alive (~250 MB each) for days, and
# agents' `tsc` runs add ~2 GB apiece. Without a guard the box swaps until
# Orca's SSH relay times out and the host is unreachable.
#
# earlyoom: kill the single largest process (usually a 2 GB `tsc`) when
# available RAM < 10% AND swap is > 10% used, instead of swapping to death.
# No `--prefer node`: Orca's relay is a small `node relay.js` process.
# The regex is unquoted on purpose: systemd splits $EARLYOOM_ARGS at
# whitespace and inner quotes would end up inside the pattern.
sudo apt-get install -y -qq earlyoom
sudo tee /etc/default/earlyoom >/dev/null <<'CONF'
EARLYOOM_ARGS="-m 10 -s 90 -r 3600 --avoid ^(sshd|systemd|systemd-journal|systemd-logind)$"
CONF
sudo systemctl enable earlyoom
sudo systemctl restart earlyoom

# claude-reaper: hourly, closes `claude` sessions nobody has typed into for days.
sudo tee /usr/local/bin/claude-reaper >/dev/null <<'REAPER'
#!/usr/bin/env bash
# Close idle `claude` TUI sessions (and their Orca terminal tab) of this user.
#
# "Idle" = now - ATIME of the session's pty (/dev/pts/N), i.e. the last INPUT
# (what `w` shows as IDLE). CPU time and pty mtime cannot be used: an idle
# Claude Code TUI still burns 2-5% CPU and its pty mtime updates every second.
#
# Nothing is lost: the transcript stays on disk, so `claude --resume` in the
# same worktree recovers the conversation.
#
# Not a durable close: Orca keeps the tab's resume record, and when that Orca
# reconnects it reopens the tab with `claude --resume <id>` (seen 2026-10-05:
# 5 of 18 came back). This frees RAM until then; closing for good is Orca's
# `terminal close` or Sleep, from the Orca that owns the tab.
#
# Limits (hours, env-overridable):
#   WRAPPER_IDLE_H=96  orca-wrapper worktrees (repo-pr-<n>, repo-claude-WO-*);
#                      it closes its own sessions after 3 days, this only
#                      catches ones it lost track of
#   PEOPLE_IDLE_H=24   everything else (people's Orca worktrees)
# DRY_RUN=1 only logs what would be closed.
set -euo pipefail

WRAPPER_IDLE_H="${WRAPPER_IDLE_H:-96}"
PEOPLE_IDLE_H="${PEOPLE_IDLE_H:-24}"
now="$(date +%s)"

for pid in $(pgrep -u "$(id -u)" -x claude || true); do
  tty="$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  [[ -z "$tty" || "$tty" == "?" ]] && continue
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -z "$cwd" ]] && continue
  atime="$(stat -c %X "/dev/$tty" 2>/dev/null || true)"
  [[ -z "$atime" ]] && continue
  idle_h=$(( (now - atime) / 3600 ))

  case "$(basename "$cwd")" in
    repo-pr-[0-9]*|repo-claude-WO-*) limit="$WRAPPER_IDLE_H" ;;
    *)                               limit="$PEOPLE_IDLE_H" ;;
  esac
  (( idle_h >= limit )) || continue

  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ' || true)"
  ppid="$(ps -o ppid= -p "$pid" | tr -d ' ' || true)"
  dry=""; [[ "${DRY_RUN:-0}" == 1 ]] && dry=" [dry run]"
  echo "claude-reaper: pid=$pid idle=${idle_h}h (limit ${limit}h) cwd=$cwd$dry"
  [[ -n "$dry" ]] && continue
  # Whole group (takes its tsc/MCP children too), then the parent shell so the
  # Orca tab exits instead of sitting at a bare prompt. Only a shell gets the HUP: if
  # Orca ever spawned claude straight from its relay, HUP would drop the relay.
  if [[ -n "$pgid" ]] && (( pgid > 1 )); then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    case "$(ps -o comm= -p "$ppid" 2>/dev/null || true)" in
      bash|sh|dash|zsh) kill -HUP "$ppid" 2>/dev/null || true ;;
    esac
  fi
done
REAPER
sudo chmod 755 /usr/local/bin/claude-reaper

sudo tee /etc/systemd/system/claude-reaper.service >/dev/null <<UNIT
[Unit]
Description=Close idle claude sessions

[Service]
Type=oneshot
User=$USER_NAME
ExecStart=/usr/local/bin/claude-reaper
UNIT

sudo tee /etc/systemd/system/claude-reaper.timer >/dev/null <<'UNIT'
[Unit]
Description=Hourly idle claude session reaper

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now claude-reaper.timer

# Swap: the third guard, and the one the host died without on 2026-09-30. A
# DigitalOcean droplet ships with none, so an agent's `tsc` or a leaked Chrome
# takes the box from "slow" to "Orca's relay stops answering" with nothing in
# between. swappiness 10 keeps it for real pressure, not routine caching.
if swapon --show --noheadings | grep -q .; then
  echo "   swap already on: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
else
  sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile && sudo mkswap -q /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "   8G /swapfile on, kept across reboots"
fi
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf >/dev/null
sudo sysctl -q -p /etc/sysctl.d/99-swappiness.conf

echo "   earlyoom active; claude-reaper runs hourly (DRY_RUN=1 /usr/local/bin/claude-reaper to preview)"

# -----------------------------------------------------------------------------
log "7/8  QA tooling (gh + agent-browser)"
# -----------------------------------------------------------------------------
# `/qa-agent` runs wherever the wrapper places a session, and the wrapper
# balances across hosts -- so a host without these tools is not "a host that
# can't do QA", it is a coin flip that fails a QA run (seen on PR 668, the
# first run that landed on a second droplet). See docs/agents/qa-agent-host.md
# in shoutkol/shout for what the skill expects.
AGENT_BROWSER_VERSION="0.38.1"

if command -v gh >/dev/null 2>&1; then
  echo "   gh already installed: $(gh --version | head -1)"
else
  # Ubuntu's own `gh` lags badly; use GitHub's repo, as the other host does.
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq gh
  echo "   installed $(gh --version | head -1)"
fi

# To the user prefix: the global npm prefix is not writable, and ~/.local/bin is
# already on PATH through Ubuntu's ~/.profile once the directory exists.
npm i -g --silent --prefix "$HOME/.local" "agent-browser@$AGENT_BROWSER_VERSION"
export PATH="$HOME/.local/bin:$PATH"

# Chrome + its system libraries. Skip the download when a browser is already
# usable -- `doctor` ends with a headless launch check, which is the real test.
if agent-browser doctor 2>&1 | grep -q "pass  Headless launch"; then
  echo "   agent-browser $(agent-browser --version) ready, browser already usable"
else
  agent-browser install --with-deps || agent-browser install
fi

# Ubuntu 24.04's AppArmor denies the unprivileged user namespaces Chrome's
# sandbox needs. Allow them for agent-browser's Chrome alone, so the sandbox
# stays ON: this host also holds the pipeline's gh token.
if [[ -d /etc/apparmor.d ]]; then
  sudo tee /etc/apparmor.d/agent-browser-chrome >/dev/null <<APPARMOR
abi <abi/4.0>,
include <tunables/global>

profile agent-browser-chrome $HOME/.agent-browser/browsers/**/chrome flags=(unconfined) {
  userns,
  include if exists <local/agent-browser-chrome>
}
APPARMOR
  sudo apparmor_parser -r /etc/apparmor.d/agent-browser-chrome || true
fi

# Every --session is its own Chrome (~500 MB) and parallel QA subagents open a
# few dozen; the stock 1 h idle timeout let 21 pile up and take the host down on
# 2026-09-30. Never clobber an existing config -- it may hold other settings.
mkdir -p "$HOME/.agent-browser"
if [[ -f "$HOME/.agent-browser/config.json" ]]; then
  echo "   ~/.agent-browser/config.json exists, left alone: $(tr -d '\n ' < "$HOME/.agent-browser/config.json")"
else
  printf '{ "idleTimeout": "10m" }\n' > "$HOME/.agent-browser/config.json"
  echo "   agent-browser idle timeout set to 10m"
fi

if gh auth status >/dev/null 2>&1; then
  echo "   gh authenticated as: $(gh auth status 2>&1 | sed -n 's/.*account \([^ ]*\).*/\1/p' | head -1)"
else
  echo "   !! gh is NOT logged in for $USER_NAME. /qa-agent needs it to read the PR,"
  echo "      post its report and set labels. Run this once, interactively, as the"
  echo "      agent account (not your personal one):"
  echo "        gh auth login"
fi

# -----------------------------------------------------------------------------
log "8/8  Repository"
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
  guards    earlyoom (OOM) + claude-reaper.timer (hourly idle-session close) + 8G swap
  qa tools  gh + agent-browser (Chrome) -- /qa-agent can run on this host

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
