# shout-agent-setup

One script that turns a blank GCE Ubuntu VM into an agent workstation you reach
through Chrome Remote Desktop: XFCE desktop + Google Chrome + Thai/CJK/emoji
fonts + Claude Desktop.

## Install

Run on the VM as a **normal user** (not root, not `sudo` — the script calls
`sudo` itself):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/shoutkol/shout-agent-setup/main/setup-vm.sh)
```

Use `bash <(...)`, not `curl | bash` — a pipe consumes stdin and breaks any
`read` in the script.

Takes ~10 minutes, mostly the XFCE install. Safe to re-run (idempotent).

## Manual step: register the CRD host

Registration needs a browser OAuth token, so it cannot be scripted.

1. Open <https://remotedesktop.google.com/headless> → Begin → Next → Authorize
2. Copy the **Debian Linux** command and run it on the VM — **without `sudo`**
   (sudo registers the host to the wrong user)
3. Set a 6+ digit PIN
4. Connect at <https://remotedesktop.google.com/access>

Log out and back in (or reboot) before step 2 if the script changed your group
membership.

## First launch of Claude Desktop

The GNOME keyring asks for a password. **Leave it blank and press OK.** A
password means unlocking it on every login, which is painful on a headless VM —
and on a VM already behind an SSH key and a CRD PIN it buys no real security.

## Tested on

| | |
|---|---|
| OS | Ubuntu 22.04 LTS (`ubuntu-2204-lts` / `ubuntu-os-cloud`) |
| Arch | **amd64 only** — Chrome and CRD ship no arm64 `.deb`; the script refuses anything else |
| Machine type | e2-standard-4 or larger |
| Zones | asia-southeast1-b, asia-southeast1-c |

XFCE rather than GNOME: ~400MB RAM instead of ~1.5GB, and no `gdm3` fighting
CRD for the X display.

## What the script does

1. Base packages (`curl gnupg wget ca-certificates`)
2. XFCE + `gnome-keyring` (Claude Desktop needs a Secret Service provider)
3. Chrome Remote Desktop host, `/etc/chrome-remote-desktop-session` → xfce4, `enable-linger`
4. Google Chrome
5. Thai + Noto CJK + emoji fonts
6. Claude Desktop from Anthropic's apt repo (so it auto-updates)
7. polkit rules that silence the unanswerable colord password prompt
8. Desktop shortcuts + default browser
9. A `chrome` alias that clears a stale `SingletonLock` before launching

## Handy commands

```bash
sudo systemctl status chrome-remote-desktop@$USER --no-pager
```

- `chrome` — launches Chrome, clearing any stale profile lock first
- `pkill -x chrome` to kill Chrome. **Never `pkill -f chrome`** — `-f` also
  matches `chrome-remote-desktop` and kills your whole session.

## Next step after a VM works

Take a GCP **Machine Image** from it. Spawning from the image is ~2 minutes
versus ~10 for the script, and this repo stays the reviewable source of truth
for rebuilding that image.
