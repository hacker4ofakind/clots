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

  echo "$head" > data/deployed-commit
  docker image prune -f >/dev/null
  echo "Deployed $head."
}

main "$@"
exit $?
