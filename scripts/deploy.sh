#!/usr/bin/env bash
# Deploy to fddatateam: pull main, rebuild, restart, smoke-test through the
# tunnel. Run from anywhere with ssh access:  scripts/deploy.sh [host]
set -euo pipefail
HOST="${1:-fddatateam}"

ssh -o BatchMode=yes "$HOST" '
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
echo "deployed; verifying through the tunnel…"
curl -sf --max-time 20 https://metcalf-think-aloud-facilitator.opengamedata.io/healthz && echo
