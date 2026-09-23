# orca-wrapper -- deploy runbook

Wires GitHub PR comments (`/orca ...`) on `shoutkol/shout` to the Orca
desktop running on the GCE VM `p-m-shouttgt-agent`, through a small always-on
service (`orca-wrapper`, systemd `--user`) and a public HTTPS front door
(Caddy, system service).

```
GitHub PR comment --workflow--> https://orca.shouttgt.com --Caddy--> 127.0.0.1:8787 orca-wrapper --> orca CLI --> Orca desktop app
```

## Prerequisites

- `setup-orca-target.sh` has already been run on this VM (system Node 22,
  git, SSH key), and this repo is checked out at `$HOME/shout-agent-setup`:
  `git clone git@github.com:shoutkol/shout-agent-setup.git ~/shout-agent-setup`.
- The Orca desktop app is running in this user's (`guy_thitiwat`) graphical
  session -- `orca-wrapper` shells out to it and does nothing without it.
- `gh auth login` has been run as this user, as the agent account (`pm607`),
  not your personal GitHub account.
- `gce-inventory.sh` has been run at least once, so `~/.local/bin/orca` (the
  CLI launcher for the Linux AppImage build) exists.

## Install

```bash
cd ~/shout-agent-setup/orca-wrapper/ops
bash install.sh
```

Idempotent -- safe to re-run. It checks the prerequisites above, installs
Caddy from the official apt repo if it isn't already, installs `Caddyfile` to
`/etc/caddy/Caddyfile`, generates `~/.config/orca-wrapper/env` (mode 600,
with a random `ORCA_WRAPPER_TOKEN`, and `ORCA_REPO_ID` auto-filled when Orca
knows about exactly one repo) on first run, then installs and starts
`orca-wrapper` as your systemd `--user` service and smoke-tests it.

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--app-dir PATH` | `$HOME/shout-agent-setup/orca-wrapper` | orca-wrapper checkout |
| `--domain NAME`  | `orca.shouttgt.com` | public hostname Caddy serves |
| `-h` | | print usage |

## Manual steps (install.sh prints these at the end too)

1. **DNS** -- point `orca.shouttgt.com` at this VM's external IP
   (`34.21.243.182`) with an A record.

2. **Firewall** -- only port 22 is open on `p-m-shouttgt-agent` today. Tag
   the instance and open `tcp:443`. Run from wherever `gcloud` is configured
   (not on the VM itself); fill in your zone (find it with
   `gcloud compute instances list --filter=name=p-m-shouttgt-agent --format='value(zone)'`):

   ```bash
   gcloud compute instances add-tags p-m-shouttgt-agent \
     --zone=<zone> --tags=orca-wrapper-https

   gcloud compute firewall-rules create allow-orca-wrapper-https \
     --network=default --direction=INGRESS --action=ALLOW \
     --rules=tcp:443 --target-tags=orca-wrapper-https \
     --source-ranges=0.0.0.0/0
   ```

3. **GitHub repo secrets** -- on `shoutkol/shout`: Settings -> Secrets and
   variables -> Actions:

   | Secret | Value |
   |---|---|
   | `ORCA_WRAPPER_URL` | `https://orca.shouttgt.com` |
   | `ORCA_WRAPPER_TOKEN` | printed by `install.sh` (also in `~/.config/orca-wrapper/env` on the VM) |

4. **Workflow** -- copy `github-workflow.yml` into `shoutkol/shout` as
   `.github/workflows/orca.yml`.

Caddy issues its own Let's Encrypt cert on the first real HTTPS request once
DNS and the firewall rule are both live -- there is no separate cert step.

## Logs

```bash
journalctl --user -u orca-wrapper -f     # the wrapper itself
sudo journalctl -u caddy -f              # reverse proxy / TLS
```

## Rotate the token

```bash
NEW="$(openssl rand -hex 32)"
sed -i "s/^ORCA_WRAPPER_TOKEN=.*/ORCA_WRAPPER_TOKEN=$NEW/" ~/.config/orca-wrapper/env
systemctl --user restart orca-wrapper
echo "$NEW"
```

Then update the `ORCA_WRAPPER_TOKEN` secret on `shoutkol/shout` to match --
the old and new tokens are not both valid at once, so do this right before
or right after, not hours apart.

## Update

```bash
cd ~/shout-agent-setup && git pull
systemctl --user restart orca-wrapper
```

If this update adds the `/tasks` (Notion work order) routes, the `sessions`/`jobs` schema changed
from PR-keyed to key-keyed and the wrapper refuses to start on the old database: stop the service, `rm
~/.local/share/orca-wrapper/state.sqlite*`, then start it again (see orca-wrapper's own
`README.md`). Newer columns on the key-keyed schema are added automatically on startup.

`ops/Caddyfile` and `ops/orca-wrapper.service` are files on disk, not
symlinks -- a plain `git pull` does not re-apply them. Re-run
`bash ops/install.sh` after `git pull` if either changed (it is idempotent
and will only touch what actually differs).
