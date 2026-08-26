#!/usr/bin/env bash
# Deploy: pull main, rebuild, restart, smoke-test through the tunnel.
#   scripts/deploy.sh [host]     # from a workstation: ssh to <host> (default fddatateam)
#   scripts/deploy.sh            # on the host itself: runs locally (auto-detected)
set -euo pipefail
HOST="${1:-fddatateam}"

REMOTE_SCRIPT='
  set -euo pipefail
  cd ~/metcalf-think-aloud-facilitator
  git pull -q
  docker build -q -t metcalf-think-aloud-facilitator:latest . >/dev/null
  docker rm -f metcalf-app >/dev/null 2>&1 || true
  # ADMIN_PASSWORD comes from ~/.metcalf-env on the host (chmod 600), never
  # from the command line where it would land in shell history and ps.
  docker run -d --name metcalf-app --restart unless-stopped \
    -p 127.0.0.1:7900:7900 -v metcalf-data:/data \
    $( [ -f ~/.metcalf-env ] && echo "--env-file $HOME/.metcalf-env" ) \
    metcalf-think-aloud-facilitator:latest >/dev/null
  sleep 2
  curl -sf http://127.0.0.1:7900/healthz
  echo
'

if [ "$(hostname -s)" = "$HOST" ]; then
  bash -c "$REMOTE_SCRIPT"
else
  ssh -o BatchMode=yes "$HOST" "$REMOTE_SCRIPT"
fi

echo "deployed; verifying through the tunnel…"
curl -sf --max-time 20 https://metcalf-think-aloud-facilitator.opengamedata.io/healthz && echo
