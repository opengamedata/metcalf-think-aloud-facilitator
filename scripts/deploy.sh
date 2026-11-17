#!/usr/bin/env bash
# Deploy: pull main, rebuild, restart, smoke-test through the tunnel.
#   scripts/deploy.sh [host]     # from a workstation: ssh to <host> (default fddatateam)
#   scripts/deploy.sh            # on the host itself: runs locally (auto-detected)
set -euo pipefail
HOST="${1:-fddatateam}"

# Repo and secret are resolved, not assumed: the project moved from
# ~watson/metcalf-think-aloud-facilitator to /home/hermes/repos/metcalf in the
# 2026-11-17 hermes-user migration, so a hardcoded `cd ~/metcalf-...` fails for
# whichever account is not the old one. REPO_DIR/METCALF_ENV can override.
REMOTE_SCRIPT='
  set -euo pipefail
  for d in "${REPO_DIR:-}" "$HOME/repos/metcalf" /home/hermes/repos/metcalf \
           "$HOME/metcalf-think-aloud-facilitator"; do
    [ -n "$d" ] && [ -d "$d/.git" ] && REPO="$d" && break
  done
  [ -n "${REPO:-}" ] || { echo "deploy: cannot find the metcalf repo on $(hostname -s)" >&2; exit 1; }
  cd "$REPO"
  echo "deploy: repo $REPO"
  git pull -q
  docker build -q -t metcalf-think-aloud-facilitator:latest . >/dev/null
  docker rm -f metcalf-app >/dev/null 2>&1 || true
  # ADMIN_PASSWORD comes from the host env file (chmod 600), never from the
  # command line where it would land in shell history and ps.
  for e in "${METCALF_ENV:-}" /home/hermes/secrets/metcalf.env "$HOME/.metcalf-env"; do
    [ -n "$e" ] && [ -f "$e" ] && ENVFILE="$e" && break
  done
  docker run -d --name metcalf-app --restart unless-stopped \
    -p 127.0.0.1:7900:7900 -v metcalf-data:/data \
    ${ENVFILE:+--env-file "$ENVFILE"} \
    metcalf-think-aloud-facilitator:latest >/dev/null
  echo "deploy: env-file ${ENVFILE:-none}"
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
