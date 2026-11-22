#!/usr/bin/env bash
# The server side of `npm run deploy`. Run as the clots user, over SSH.
set -euo pipefail

IMAGE=clots-clot:dev
cd "$(dirname "${BASH_SOURCE[0]}")/.."

dirty=$(git status --porcelain)
if [ -n "$dirty" ]; then
  echo "The checkout has local changes; not deploying:" >&2
  echo "$dirty" >&2
  exit 1
fi

git pull --ff-only
head=$(git rev-parse HEAD)
mkdir -p data

# The last commit that deployed successfully, not the pre-pull HEAD: a deploy that failed after the
# pull (npm ci, the image build, the restart) must be redone in full by the next one.
last=""
if [ -f data/deployed-commit ]; then last=$(cat data/deployed-commit); fi
if [ -n "$last" ] && ! git cat-file -e "$last^{commit}" 2>/dev/null; then last=""; fi

if [ "$last" = "$head" ]; then
  echo "Already up to date ($head)."
  exit 0
fi

if [ -z "$last" ]; then
  echo "No successful deploy recorded: running every step."
  changed=$'package-lock.json\ndocker/'
else
  changed=$(git diff --name-only "$last" HEAD)
fi

node_now=$(node --version)
node_recorded=""
if [ -f data/node-version ]; then node_recorded=$(cat data/node-version); fi

if echo "$changed" | grep -qx 'package-lock.json' || [ ! -d node_modules ] || [ "$node_recorded" != "$node_now" ]; then
  echo "npm ci: running"
  npm ci
  echo "$node_now" > data/node-version
else
  echo "npm ci: lockfile unchanged, skipped"
fi

if echo "$changed" | grep -q '^docker/' || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "image: rebuilding $IMAGE"
  docker build -t "$IMAGE" docker
else
  echo "image: docker/ unchanged, skipped"
fi

echo "service: restarting"
sudo systemctl restart clots
sleep 5
systemctl status clots --no-pager || true
journalctl -u clots -n 20 --no-pager || true

if ! systemctl is-active --quiet clots; then
  echo "The service is not active after the restart. Deploy failed; the next run redoes every step." >&2
  exit 1
fi

echo "$head" > data/deployed-commit
docker image prune -f >/dev/null
echo "Deployed $head."
