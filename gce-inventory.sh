#!/usr/bin/env bash
# Read-only inventory of the GCE Orca desktop for the PR-comment wrapper. Run as guy_thitiwat, paste the output back.
p() { printf '\n== %s\n' "$*"; }
p host;            echo "$(hostname) / $(id -un) / $(lsb_release -ds 2>/dev/null)"
p orca version;    command -v orca && orca --version
p orca status;     orca status --json 2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print('app.running=',d['app']['running'],'runtime=',d['runtime']['state'],'appVersion=',d['runtime'].get('appVersion'))" 2>&1
p orca environments; orca environment list --json 2>&1 | head -c 1500; echo
p orca repos;      orca repo list --json 2>&1 | python3 -c "
import json,sys; d=json.load(sys.stdin)['result']; items=d.get('repos') or d.get('repositories') or d
for x in (items if isinstance(items,list) else []): print(' ', x.get('id'), '|', x.get('path') or x.get('rootPath'), '| host=', x.get('hostId') or x.get('host'))" 2>&1
p orca projects;   orca project list --json 2>&1 | head -c 2500; echo
p orca worktrees;  orca worktree list --json 2>&1 | python3 -c "
import json,sys; d=json.load(sys.stdin)['result']
for w in d.get('worktrees',[])[:15]: print(' ', w.get('id'), '| branch=', w.get('branch'), '| host=', w.get('hostId') or w.get('host'))
print(' scope:', d.get('scope'))" 2>&1
p orca automations; orca automations list --json 2>&1 | python3 -c "import json,sys; [print(' ',a['name'],'enabled=',a['enabled'],'host=',a.get('executionTargetId')) for a in json.load(sys.stdin)['result']['automations']]" 2>&1
p gh;              command -v gh && gh auth status 2>&1 | grep -iE 'logged in|account|token scopes' ; git config --global user.name; git config --global user.email
p node;            command -v node && node -v
p caddy / ports;   command -v caddy || echo "caddy: none"; (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | awk 'NR==1||/LISTEN/' | head -15
p public ip;       curl -s --max-time 5 ifconfig.me; echo
p systemd user;    systemctl --user list-units --type=service --state=running --no-pager 2>/dev/null | head -12
