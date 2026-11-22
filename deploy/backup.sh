#!/usr/bin/env bash
# One backup archive in ~/clots-backups, named by date; keeps the 7 newest. Run as the clots user.
set -euo pipefail
umask 077

IMAGE=clots-clot:dev
KEEP=7
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f data/clots.db ]; then
  echo "No data/clots.db yet; nothing to back up."
  exit 0
fi

dest=$HOME/clots-backups
mkdir -p "$dest"
today=$(date +%F)
work=$(mktemp -d "$dest/.work.XXXXXX")
trap 'rm -rf "$work" "$dest/.$today.tar.gz.part"' EXIT

# The online backup API: consistent while the daemon runs in WAL mode.
sqlite3 data/clots.db ".backup '$work/clots.db'"

if [ -d rulebook ]; then cp -a rulebook "$work/rulebook"; fi

# The configuration is gitignored and the Clots edit it, so it is kept too. It names .env keys and holds no secret; .env itself is not backed up here.
if [ -f clots.config.json ]; then cp -a clots.config.json "$work/clots.config.json"; fi

# Each Clot's home volume holds its Claude login and its session transcripts. The work volumes are
# left out: they are clones GitHub already holds. .credentials.json is mode 600 and owned by the
# container's user, so the volume is read as root, and the archive is handed back to this user.
uid=$(id -u)
gid=$(id -g)
# A failing `docker volume ls` stops the script (set -e) instead of looking like "no volumes".
all_volumes=$(docker volume ls --format '{{.Name}}')
while read -r vol; do
  [ -n "$vol" ] || continue
  docker run --rm -v "$vol:/v:ro" -v "$work:/out" --user 0 --entrypoint sh "$IMAGE" \
    -c "tar cf /out/$vol.tar -C /v . && chown $uid:$gid /out/$vol.tar"
done < <(grep -E '^clot-.*-home$' <<< "$all_volumes" || true)

# Write under a temp name, then rename, so a failed run never leaves a half archive.
tar czf "$dest/.$today.tar.gz.part" -C "$work" .
mv -f "$dest/.$today.tar.gz.part" "$dest/$today.tar.gz"
echo "Wrote $dest/$today.tar.gz"

shopt -s nullglob
archives=("$dest"/????-??-??.tar.gz)
extra=$(( ${#archives[@]} - KEEP ))
if [ "$extra" -gt 0 ]; then
  rm -f -- "${archives[@]:0:extra}"
  echo "Removed $extra old archive(s)."
fi
