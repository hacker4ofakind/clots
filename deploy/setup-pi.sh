#!/usr/bin/env bash
# Host setup for a Clots server (Ubuntu, arm64 or x64). Run with sudo, from the clone or before it
# exists. Every step checks whether it is already done, so running it again changes nothing.
set -euo pipefail

CLOTS_USER=clots
CLOTS_HOME=/home/clots
CHECKOUT=$CLOTS_HOME/clots
REPO_URL=https://github.com/hacker4ofakind/clots.git
NODE_VERSION=26.13.1
NODE_MAJOR=26
IMAGE=clots-clot:dev
FUNNEL_PORT=8787
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd /

say() { printf '==> %s\n' "$*"; }
done_already() { printf '    %s: already done\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi
if ! id "$CLOTS_USER" >/dev/null 2>&1; then
  echo "There is no '$CLOTS_USER' user on this host. Create it first (see README)." >&2
  exit 1
fi
if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale is not installed. Install it and join the tailnet first (see README)." >&2
  exit 1
fi

as_clots() { sudo -u "$CLOTS_USER" -H "$@"; }

# install_file SRC DST MODE: copies only when DST is missing or differs. Returns 1 when unchanged.
install_file() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    return 1
  fi
  install -m "$3" "$1" "$2"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ARCH=$(dpkg --print-architecture)
# shellcheck source=/dev/null
CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
APT_DIRTY=0

# --- Ubuntu updates pocket -----------------------------------------------------------------------
# Some installs lack <codename>-updates, which leaves apt unable to match the newer libraries already
# on the host with the release-pocket packages (e.g. sqlite3 needing libsqlite3-0).
say "Ubuntu updates pocket"
UBUNTU_SOURCES=/etc/apt/sources.list.d/ubuntu.sources
if grep -rqs "${CODENAME}-updates" /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null; then
  done_already "${CODENAME}-updates"
elif [ -f "$UBUNTU_SOURCES" ]; then
  ubuntu_uri=$(awk '/^URIs:/ { print $2; exit }' "$UBUNTU_SOURCES")
  cat > "$TMP/ubuntu-updates.sources" <<EOF
Types: deb
URIs: $ubuntu_uri
Suites: ${CODENAME}-updates
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  install_file "$TMP/ubuntu-updates.sources" /etc/apt/sources.list.d/ubuntu-updates.sources 0644
  APT_DIRTY=1
fi

# --- apt prerequisites ---------------------------------------------------------------------------
say "apt prerequisites"
if [ "$APT_DIRTY" -eq 1 ]; then apt-get update; APT_DIRTY=0; fi
missing=()
for pkg in ca-certificates curl gnupg git sqlite3 build-essential python3; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if [ "${#missing[@]}" -gt 0 ]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
else
  done_already "prerequisites"
fi

# --- apt repositories ----------------------------------------------------------------------------
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  APT_DIRTY=1
fi
if [ ! -f /etc/apt/keyrings/nodesource.gpg ]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o "$TMP/nodesource.gpg"
  install -m 0644 "$TMP/nodesource.gpg" /etc/apt/keyrings/nodesource.gpg
  APT_DIRTY=1
fi
echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" > "$TMP/docker.list"
if install_file "$TMP/docker.list" /etc/apt/sources.list.d/docker.list 0644; then APT_DIRTY=1; fi
echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > "$TMP/nodesource.list"
if install_file "$TMP/nodesource.list" /etc/apt/sources.list.d/nodesource.list 0644; then APT_DIRTY=1; fi
if [ "$APT_DIRTY" -eq 1 ]; then apt-get update; fi

# --- Docker --------------------------------------------------------------------------------------
say "Docker Engine"
docker_missing=()
for pkg in docker-ce docker-ce-cli containerd.io docker-buildx-plugin; do
  dpkg -s "$pkg" >/dev/null 2>&1 || docker_missing+=("$pkg")
done
if [ "${#docker_missing[@]}" -gt 0 ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${docker_missing[@]}"
else
  done_already "docker packages"
fi
systemctl is-active --quiet docker || systemctl enable --now docker

NEW_GROUPS=()
for grp in docker systemd-journal; do
  if ! id -nG "$CLOTS_USER" | tr ' ' '\n' | grep -qx "$grp"; then
    usermod -aG "$grp" "$CLOTS_USER"
    NEW_GROUPS+=("$grp")
  fi
done

# --- Node ----------------------------------------------------------------------------------------
say "Node.js $NODE_VERSION"
want=$(apt-cache madison nodejs | awk -v v="$NODE_VERSION" 'index($3, v "-") == 1 { print $3; exit }')
if [ -z "$want" ]; then
  echo "Node.js $NODE_VERSION is not in the NodeSource $NODE_MAJOR.x repository. Stopping." >&2
  exit 1
fi
have=$(dpkg-query -W -f='${Version}' nodejs 2>/dev/null || true)
if [ "$have" != "$want" ]; then
  apt-mark unhold nodejs >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "nodejs=$want"
else
  done_already "nodejs $want"
fi
apt-mark showhold | grep -qx nodejs || apt-mark hold nodejs

# --- cloud-init ----------------------------------------------------------------------------------
say "cloud-init"
if [ -d /etc/cloud ] && [ ! -f /etc/cloud/cloud-init.disabled ]; then
  touch /etc/cloud/cloud-init.disabled
else
  done_already "cloud-init disabled"
fi

# --- checkout ------------------------------------------------------------------------------------
say "Checkout"
if [ -d "$CHECKOUT" ]; then
  done_already "$CHECKOUT exists (deploy/update.sh owns it)"
else
  as_clots git clone "$REPO_URL" "$CHECKOUT"
fi

say "npm ci"
cur_node=$(node --version)
recorded=""
if [ -f "$CHECKOUT/data/node-version" ]; then recorded=$(cat "$CHECKOUT/data/node-version"); fi
if [ ! -d "$CHECKOUT/node_modules" ] || [ "$recorded" != "$cur_node" ]; then
  # shellcheck disable=SC2016
  as_clots bash -c 'cd "$1" && mkdir -p data && npm ci && node --version > data/node-version' _ "$CHECKOUT"
else
  done_already "node_modules built with $cur_node"
fi

say "Clot image $IMAGE"
BUILD_SECONDS=""
if as_clots docker image inspect "$IMAGE" >/dev/null 2>&1; then
  done_already "image exists"
else
  started=$(date +%s)
  # shellcheck disable=SC2016
  as_clots bash -c 'cd "$1" && docker build -t "$2" docker' _ "$CHECKOUT" "$IMAGE"
  BUILD_SECONDS=$(( $(date +%s) - started ))
fi

# --- units and sudoers ---------------------------------------------------------------------------
say "systemd units and sudoers"
UNITS_CHANGED=0
for unit in "$SCRIPT_DIR"/*.service "$SCRIPT_DIR"/*.timer; do
  if install_file "$unit" "/etc/systemd/system/$(basename "$unit")" 0644; then
    echo "    installed $(basename "$unit")"
    UNITS_CHANGED=1
  fi
done
if [ ! -f /etc/sudoers.d/clots ] || ! cmp -s "$SCRIPT_DIR/clots-sudoers" /etc/sudoers.d/clots; then
  # A broken file in /etc/sudoers.d locks sudo out, so validate before it goes into place.
  visudo -cf "$SCRIPT_DIR/clots-sudoers" >/dev/null
  install -m 0440 "$SCRIPT_DIR/clots-sudoers" /etc/sudoers.d/clots
  echo "    installed sudoers rule"
else
  done_already "sudoers rule"
fi
if [ "$UNITS_CHANGED" -eq 1 ]; then
  systemctl daemon-reload
else
  done_already "units"
fi

systemctl is-enabled --quiet clots || systemctl enable clots
systemctl is-enabled --quiet clots-backup.timer || systemctl enable clots-backup.timer
systemctl is-active --quiet clots-backup.timer || systemctl start clots-backup.timer

# --- Funnel --------------------------------------------------------------------------------------
say "Tailscale Funnel on $FUNNEL_PORT"
FUNNEL_FAILED=0
if tailscale funnel status 2>&1 | grep -q "$FUNNEL_PORT"; then
  done_already "funnel"
elif ! tailscale funnel --bg "$FUNNEL_PORT"; then
  FUNNEL_FAILED=1
  echo "    Funnel did not start. If the output above has a link, open it to allow Funnel for this machine." >&2
fi

# --- start the service once its config exists ----------------------------------------------------
say "Service"
ENV_STATE=missing
CONFIG_STATE=missing
[ -f "$CHECKOUT/.env" ] && ENV_STATE=present
[ -f "$CHECKOUT/clots.config.json" ] && CONFIG_STATE=present
if [ "$ENV_STATE" = present ] && [ "$CONFIG_STATE" = present ]; then
  if systemctl is-active --quiet clots; then
    done_already "clots is running"
    if [ "$UNITS_CHANGED" -eq 1 ]; then echo "    (unit files changed: run 'sudo systemctl restart clots' to apply)"; fi
  else
    systemctl start clots
  fi
else
  echo "    not started: waiting for the config files below"
fi

# --- summary -------------------------------------------------------------------------------------
echo
echo "Summary"
echo "  Node:        $(node --version)"
echo "  Docker:      $(docker --version)"
if [ -n "$BUILD_SECONDS" ]; then build_note="${BUILD_SECONDS}s"; else build_note="not built this run"; fi
echo "  Image build: $build_note"
echo "  .env:                $ENV_STATE ($CHECKOUT/.env)"
echo "  clots.config.json:   $CONFIG_STATE ($CHECKOUT/clots.config.json)"
echo "  Funnel:      $(tailscale funnel status 2>/dev/null | grep -o 'https://[^ ]*' | head -1 || true)"
if [ "${#NEW_GROUPS[@]}" -gt 0 ]; then
  echo "  '$CLOTS_USER' was added to: ${NEW_GROUPS[*]}. Log in again for that to take effect (the service is unaffected)."
fi
if [ "$FUNNEL_FAILED" -eq 1 ]; then exit 1; fi
