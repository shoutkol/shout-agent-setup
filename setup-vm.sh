#!/usr/bin/env bash
# =============================================================================
#  GCE Ubuntu VM -> XFCE desktop over Chrome Remote Desktop
#  + Google Chrome + Thai fonts + Claude Desktop
#
#  Run as a NORMAL user (not root, not sudo):
#      bash setup-vm.sh
#
#  Idempotent: safe to re-run.
#  After it finishes, register the CRD host manually (see printed instructions).
# =============================================================================
set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "!! Run this as a normal user, not root/sudo. The script calls sudo itself."
  exit 1
fi

trap 'echo -e "\n\033[1;31m!! FAILED at line $LINENO\033[0m"; exit 1' ERR

if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
  echo "!! amd64 only -- Google Chrome and Chrome Remote Desktop have no arm64 .deb"
  exit 1
fi

USER_NAME="$(id -un)"
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive

# -----------------------------------------------------------------------------
log "1/9  Base packages"
# -----------------------------------------------------------------------------
sudo apt-get update -qq
sudo apt-get install -y -qq curl gnupg wget ca-certificates

# -----------------------------------------------------------------------------
log "2/9  XFCE desktop  (~3-5 min)"
# -----------------------------------------------------------------------------
# XFCE over GNOME: ~400MB RAM vs ~1.5GB, and no GDM/Wayland fight with CRD.
sudo apt-get install -y -qq xfce4 xfce4-goodies dbus-x11 xscreensaver

# Claude Desktop stores its session token via the Secret Service API. Without a
# keyring daemon it warns "Your sign-in won't be saved on this device" and makes
# you log in again on every launch.
sudo apt-get install -y -qq gnome-keyring libsecret-1-0 seahorse

# -----------------------------------------------------------------------------
log "3/9  Chrome Remote Desktop host"
# -----------------------------------------------------------------------------
if ! dpkg -l chrome-remote-desktop 2>/dev/null | grep -q '^ii'; then
  wget -q https://dl.google.com/linux/direct/chrome-remote-desktop_current_amd64.deb \
       -O /tmp/crd.deb
  sudo apt-get install -y -qq /tmp/crd.deb
  rm -f /tmp/crd.deb
fi

# Heredoc, not echo with quotes -- avoids the smart-quote trap entirely.
sudo tee /etc/chrome-remote-desktop-session > /dev/null <<'EOF'
exec /etc/X11/Xsession /usr/bin/xfce4-session
EOF

# Newer CRD builds are sandboxed (_crd_network / _crd_peer_connection service
# users) and no longer create this group at all; older builds require it.
# Guarded so `set -e` does not abort the whole run on a missing group.
if getent group chrome-remote-desktop >/dev/null; then
  sudo usermod -aG chrome-remote-desktop "$USER_NAME"
else
  echo "   (skipped: sandboxed CRD build, no chrome-remote-desktop group)"
fi

# Keeps the user's systemd slice alive across reboots. Without this the service
# fails on boot with: "user-XXXX.slice has 'stop' job queued".
sudo loginctl enable-linger "$USER_NAME"

sudo systemctl enable chrome-remote-desktop@"$USER_NAME" >/dev/null 2>&1 || true

# -----------------------------------------------------------------------------
log "4/9  Google Chrome"
# -----------------------------------------------------------------------------
if ! dpkg -l google-chrome-stable 2>/dev/null | grep -q '^ii'; then
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
       -O /tmp/chrome.deb
  sudo apt-get install -y -qq /tmp/chrome.deb
  rm -f /tmp/chrome.deb
fi

# -----------------------------------------------------------------------------
log "5/9  Fonts (Thai + CJK + emoji)"
# -----------------------------------------------------------------------------
# Without these, Thai text renders as tofu boxes in Chrome/Notion.
sudo apt-get install -y -qq \
  fonts-thai-tlwg fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji
fc-cache -f >/dev/null

# -----------------------------------------------------------------------------
log "6/9  Claude Desktop (apt repo, so it gets updates)"
# -----------------------------------------------------------------------------
if [[ ! -f /usr/share/keyrings/claude-desktop-archive-keyring.asc ]]; then
  sudo curl -fsSLo /usr/share/keyrings/claude-desktop-archive-keyring.asc \
    https://downloads.claude.ai/claude-desktop/key.asc
fi

echo "Signing key fingerprint (expect 31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE):"
gpg --show-keys /usr/share/keyrings/claude-desktop-archive-keyring.asc 2>/dev/null \
  | grep -A1 pub | tail -1 || true

echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main" \
  | sudo tee /etc/apt/sources.list.d/claude-desktop.list > /dev/null

sudo apt-get update -qq
sudo apt-get install -y -qq claude-desktop

# -----------------------------------------------------------------------------
log "7/9  Suppress the colord polkit password prompt"
# -----------------------------------------------------------------------------
# On a headless VM colord asks for a root password on every login. There is no
# local password on GCE (SSH keys only), so the dialog is unanswerable.
sudo mkdir -p /etc/polkit-1/localauthority/50-local.d /etc/polkit-1/rules.d

sudo tee /etc/polkit-1/localauthority/50-local.d/45-allow-colord.pkla > /dev/null <<'EOF'
[Allow Colord all Users]
Identity=unix-user:*
Action=org.freedesktop.color-manager.create-device;org.freedesktop.color-manager.create-profile;org.freedesktop.color-manager.delete-device;org.freedesktop.color-manager.delete-profile;org.freedesktop.color-manager.modify-device;org.freedesktop.color-manager.modify-profile
ResultAny=no
ResultInactive=no
ResultActive=yes
EOF

# polkit >= 0.106 (Ubuntu 24.04+) reads rules.d instead of localauthority.
sudo tee /etc/polkit-1/rules.d/45-allow-colord.rules > /dev/null <<'EOF'
polkit.addRule(function(action, subject) {
  if (action.id.indexOf("org.freedesktop.color-manager.") === 0 &&
      subject.isInGroup("users")) {
    return polkit.Result.YES;
  }
});
EOF

sudo systemctl restart polkit || true

# -----------------------------------------------------------------------------
log "8/9  Desktop shortcuts + default browser"
# -----------------------------------------------------------------------------
mkdir -p "$HOME/Desktop"

# Claude ships as com.anthropic.Claude.desktop, not claude-desktop.desktop --
# glob so a future rename does not silently drop the shortcut.
while IFS= read -r src; do
  cp -f "$src" "$HOME/Desktop/" && chmod +x "$HOME/Desktop/$(basename "$src")"
done < <(find /usr/share/applications -maxdepth 1 \
           \( -iname '*claude*.desktop' -o -iname 'google-chrome.desktop' \) 2>/dev/null)

xdg-settings set default-web-browser google-chrome.desktop 2>/dev/null || true

# -----------------------------------------------------------------------------
log "9/9  Convenience alias for Chrome's stale profile lock"
# -----------------------------------------------------------------------------
# Rebooting without closing Chrome leaves a SingletonLock naming the OLD
# hostname. Chrome then refuses to start: "profile appears to be in use by
# another Google Chrome process on another computer". Deleting these three
# files is safe -- bookmarks, passwords, history and extensions are untouched.
if ! grep -q "alias chrome=" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<'EOF'

# Clear stale Chrome profile lock before launching (survives VM reboots/renames)
alias chrome='rm -f ~/.config/google-chrome/Singleton{Lock,Socket,Cookie}; google-chrome >/dev/null 2>&1 &'
EOF
fi

# =============================================================================
cat <<BANNER

=============================================================================
  Package setup done.

  ONE MANUAL STEP LEFT -- registering the CRD host needs a browser OAuth
  token, which cannot be scripted.

    1. Open  https://remotedesktop.google.com/headless
    2. Begin -> Next -> Authorize
    3. Copy the "Debian Linux" command and run it HERE as $USER_NAME
       (NO sudo -- sudo will register the host to the wrong user)
    4. Set a 6+ digit PIN

  Then:  https://remotedesktop.google.com/access

  Group membership was just changed, so log out and back in (or reboot)
  before running the registration command.

  Handy commands afterwards:
    sudo systemctl status chrome-remote-desktop@$USER_NAME --no-pager
    chrome            # launches Chrome, clearing any stale lock first
    claude-desktop    # or use the Desktop icon

  First time you open Claude Desktop, the keyring asks for a password.
  LEAVE IT BLANK and press OK -- otherwise you must unlock it on every
  login, which is painful on a headless VM.

  Tip: once this VM works the way you want, take a Machine Image in the
  GCP console. Next time you spawn a VM you skip all of the above.
=============================================================================

BANNER
