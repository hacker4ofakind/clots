#!/usr/bin/env bash
# The server side of `npm run deploy`. Run as the clots user, over SSH.
set -euo pipefail

IMAGE=clots-clot:dev
READY_TIMEOUT=180

# Everything is inside a function that is called at the end: bash reads a script as it runs, and the
# `git pull` below can replace this very file.
main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."

  local dirty
  dirty=$(git status --porcelain)
  if [ -n "$dirty" ]; then
    echo "The checkout has local changes; not deploying:" >&2
    echo "$dirty" >&2
    return 1
  fi

  git pull --ff-only
  local head
  head=$(git rev-parse HEAD)
  mkdir -p data

  # The last commit that deployed successfully, not the pre-pull HEAD: a deploy that failed after the
  # pull (npm ci, the image build, the restart) must be redone in full by the next one.
  local last=""
  if [ -f data/deployed-commit ]; then last=$(cat data/deployed-commit); fi
  if [ -n "$last" ] && ! git cat-file -e "$last^{commit}" 2>/dev/null; then last=""; fi

  if [ "$last" = "$head" ]; then
    echo "Already up to date ($head)."
    return 0
  fi

  local changed
  if [ -z "$last" ]; then
    echo "No successful deploy recorded: running every step."
    changed=$'package-lock.json\ndocker/'
  else
    changed=$(git diff --name-only "$last" HEAD)
  fi

  local node_now node_recorded=""
  node_now=$(node --version)
  if [ -f data/node-version ]; then node_recorded=$(cat data/node-version); fi

  if grep -qx 'package-lock.json' <<< "$changed" || [ ! -d node_modules ] || [ "$node_recorded" != "$node_now" ]; then
    echo "npm ci: running"
    npm ci
    echo "$node_now" > data/node-version
  else
    echo "npm ci: lockfile unchanged, skipped"
  fi

  # The web app is built on the server, and only when what it is made of changed (or was never built).
  if grep -qE '^(web/|packages/|package-lock.json)' <<< "$changed" || [ ! -d web/.next ]; then
    echo "web: building"
    npm run web:build
  else
    echo "web: unchanged, skipped"
  fi

  if grep -q '^docker/' <<< "$changed" || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "image: rebuilding $IMAGE"
    docker build -t "$IMAGE" docker
  else
    echo "image: docker/ unchanged, skipped"
  fi

  echo "service: restarting"
  local since
  since=$(date '+%Y-%m-%d %H:%M:%S')
  sudo systemctl restart clots

  # The daemon prints "[events] ready" last in its startup. Waiting for that line, from this restart,
  # catches a failure after the process has started (a Discord login, a container) as well as a bad config.
  local ready=0 waited=0 log
  while [ "$waited" -lt "$READY_TIMEOUT" ]; do
    if ! systemctl is-active --quiet clots; then break; fi
    log=$(journalctl -u clots --since "$since" --no-pager 2>/dev/null || true)
    if [[ $log == *"[events] ready"* ]]; then ready=1; break; fi
    sleep 2
    waited=$((waited + 2))
  done

  systemctl status clots --no-pager || true
  journalctl -u clots -n 20 --no-pager || true

  if [ "$ready" -ne 1 ] || ! systemctl is-active --quiet clots; then
    echo "The service did not become ready after the restart. Deploy failed; the next run redoes every step." >&2
    return 1
  fi

  # The web app gets its own environment file: the shared secret (the daemon makes it at its first start, so it is read
  # only now) and where the daemon's API listens. Never the daemon's whole .env.
  local secret
  secret=$(grep -E '^CLOTS_UI_SECRET=' .env | head -1 | cut -d= -f2- || true)
  if [ -z "$secret" ]; then
    echo "CLOTS_UI_SECRET is not in .env yet; the daemon makes it at its first start." >&2
    return 1
  fi
  umask 077
  printf 'CLOTS_UI_SECRET=%s\nCLOTS_DAEMON_URL=http://127.0.0.1:8788\n' "$secret" > data/web.env
  echo "web: restarting"
  sudo systemctl restart clots-web

  # The web UI is published to the tailnet only, on 8443. Funnel keeps 443 for webhooks.
  if ! tailscale serve status 2>/dev/null | grep -q '8443'; then
    tailscale serve --bg --https=8443 http://127.0.0.1:3000 || echo "tailscale serve did not start; run: tailscale serve --bg --https=8443 http://127.0.0.1:3000" >&2
  fi

  local web_ready=0 web_waited=0
  while [ "$web_waited" -lt 60 ]; do
    if curl -s -o /dev/null http://127.0.0.1:3000/offline; then web_ready=1; break; fi
    sleep 2
    web_waited=$((web_waited + 2))
  done
  systemctl status clots-web --no-pager || true
  if [ "$web_ready" -ne 1 ] || ! systemctl is-active --quiet clots-web; then
    echo "The web app did not come up. Deploy failed; the next run redoes every step." >&2
    return 1
  fi

  echo "$head" > data/deployed-commit
  docker image prune -f >/dev/null
  echo "Deployed $head."
}

main "$@"
exit $?
