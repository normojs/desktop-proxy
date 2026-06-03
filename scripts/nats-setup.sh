#!/usr/bin/env bash
#
# One-click NATS server setup for the desktop-proxy remote bus — Docker only.
#
# Online install (on the SERVER, as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/normojs/desktop-proxy/main/scripts/nats-setup.sh -o nats-setup.sh
#   sudo DOMAIN=nats.example.com TLS=letsencrypt bash nats-setup.sh
#   # already have nginx/cert:
#   sudo TLS=existing DOMAIN=nats.example.com \
#        CERT_FILE=/etc/letsencrypt/live/nats.example.com/fullchain.pem \
#        KEY_FILE=/etc/letsencrypt/live/nats.example.com/privkey.pem bash nats-setup.sh
#
# Runs nats-server in Docker (--restart unless-stopped = boot autostart), TLS via
# your cert, decentralized JWT accounts (MEMORY resolver, no push). Prints the
# `remote` block to paste into each desktop's ~/.desktop-proxy/config.json.
# After this, adding desktops/phones needs NO server operation.
#
# Vars: DOMAIN(optional) TLS=letsencrypt|selfsigned(default)|existing  PORT(4222) WS_PORT(8443)
#       CERT_FILE/KEY_FILE (TLS=existing)  NATS_IMAGE(nats:latest)  NATS_DIR(/etc/nats)
#       SKIP_NSC=1
# China network:
#       PROXY=http://127.0.0.1:7890          proxy for downloads + Docker install
#       GH_MIRROR=https://ghfast.top/          GitHub mirror prefix (for nsc download)
#       DOCKER_MIRROR=https://docker.m.daocloud.io   Docker registry mirror (image pull)
#       DOCKER_INSTALL_MIRROR=Aliyun          mirror for installing Docker itself
# Safe to re-run (idempotent): reuses existing accounts/keys and the container.

set -euo pipefail
export PATH="/usr/local/bin:/usr/local/sbin:$PATH"

TLS="${TLS:-selfsigned}"; PORT="${PORT:-4222}"; WS_PORT="${WS_PORT:-8443}"
NATS_DIR="${NATS_DIR:-/etc/nats}"; DOMAIN="${DOMAIN:-}"; SKIP_NSC="${SKIP_NSC:-0}"
NATS_IMAGE="${NATS_IMAGE:-nats:latest}"
PROXY="${PROXY:-}"; GH_MIRROR="${GH_MIRROR:-}"; DOCKER_MIRROR="${DOCKER_MIRROR:-}"; DOCKER_INSTALL_MIRROR="${DOCKER_INSTALL_MIRROR:-}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
HOST_ADDR="${DOMAIN:-$(hostname -I 2>/dev/null | awk '{print $1}')}"

arch() { case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; *) echo amd64;; esac; }
need() { command -v "$1" >/dev/null 2>&1; }
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
CURL_OPTS=(-fL --retry 3 --retry-delay 2 --connect-timeout 20)
[ -n "$PROXY" ] && CURL_OPTS+=(--proxy "$PROXY")
ghurl() { case "$1" in https://github.com/*|https://raw.githubusercontent.com/*) echo "${GH_MIRROR}$1";; *) echo "$1";; esac; }
DEFAULT_MIRRORS=("https://ghfast.top/" "https://ghproxy.net/" "https://gh-proxy.com/")
dl() { local raw="$1" out="$2"; say "Downloading $(ghurl "$raw")"
  curl "${CURL_OPTS[@]}" --progress-bar -o "$out" "$(ghurl "$raw")" && return 0
  if [ -z "$GH_MIRROR" ]; then case "$raw" in https://github.com/*|https://raw.githubusercontent.com/*)
    for m in "${DEFAULT_MIRRORS[@]}"; do say "Retry via mirror ${m}"; curl "${CURL_OPTS[@]}" --progress-bar -o "$out" "${m}${raw}" && return 0; done;; esac
  fi; return 1; }

# package manager for host deps (jq/unzip/openssl/nsc)
PM_INSTALL=""; APT_UPDATED=0
if   need apt-get; then PM_INSTALL="apt-get install -y"
elif need dnf;     then PM_INSTALL="dnf install -y"
elif need yum;     then PM_INSTALL="yum install -y"
elif need zypper;  then PM_INSTALL="zypper install -y"
elif need pacman;  then PM_INSTALL="pacman -S --noconfirm"
elif need apk;     then PM_INSTALL="apk add --no-cache"; fi
pkg_install() { [ -n "$PM_INSTALL" ] || { echo "!! No package manager; install manually: $*"; return 1; }
  if [ "${PM_INSTALL%% *}" = "apt-get" ] && [ "$APT_UPDATED" = "0" ]; then $SUDO apt-get update -y >/dev/null 2>&1 || true; APT_UPDATED=1; fi
  $SUDO $PM_INSTALL "$@"; }
ensure() { local cmd="$1" pkg="${2:-$1}"; need "$cmd" && return 0
  say "Installing dependency: $pkg"; pkg_install "$pkg" || { echo "!! Could not auto-install '$pkg'."; exit 1; }
  need "$cmd" || { echo "!! '$cmd' still missing."; exit 1; }; }

say "desktop-proxy NATS (Docker) setup — TLS=$TLS, host=$HOST_ADDR:$PORT/$WS_PORT${PROXY:+, proxy=$PROXY}${DOCKER_MIRROR:+, registry=$DOCKER_MIRROR}"

# Free ports from a host nats-server (systemd) created by earlier, pre-Docker runs.
if need systemctl && systemctl is-enabled nats >/dev/null 2>&1; then
  say "Stopping old systemd 'nats' service (this build is Docker-only)"
  $SUDO systemctl disable --now nats >/dev/null 2>&1 || true
fi

# ── 1. host deps + nsc ───────────────────────────────────────────────────────
ensure curl
[ "$SKIP_NSC" = "1" ] || { ensure jq; ensure unzip; }
if [ "$SKIP_NSC" != "1" ] && ! need nsc; then
  say "Installing nsc"
  dl "https://github.com/nats-io/nsc/releases/latest/download/nsc-linux-$(arch).zip" /tmp/nsc.zip \
    || { echo "!! nsc download failed — set GH_MIRROR=https://ghfast.top/ or PROXY=..."; exit 1; }
  $SUDO unzip -o /tmp/nsc.zip -d /usr/local/bin >/dev/null || { echo "!! nsc unzip failed (bad download?)"; exit 1; }
  { [ -x /usr/local/bin/nsc ] || need nsc; } || { echo "!! nsc not installed"; exit 1; }
fi

# ── 2. Docker (install + registry mirror + pull) ─────────────────────────────
if ! need docker; then
  say "Installing Docker (get.docker.com${DOCKER_INSTALL_MIRROR:+ --mirror $DOCKER_INSTALL_MIRROR})"
  curl "${CURL_OPTS[@]}" -o /tmp/get-docker.sh https://get.docker.com || { echo "!! could not fetch Docker installer (set PROXY=...)"; exit 1; }
  GA=(); [ -n "$DOCKER_INSTALL_MIRROR" ] && GA+=(--mirror "$DOCKER_INSTALL_MIRROR")
  if [ ${#GA[@]} -gt 0 ]; then $SUDO sh /tmp/get-docker.sh "${GA[@]}"; else $SUDO sh /tmp/get-docker.sh; fi
fi
need docker || { echo "!! Docker not available — install manually then re-run."; exit 1; }
$SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true
if [ -n "$DOCKER_MIRROR" ]; then
  say "Setting Docker registry mirror: $DOCKER_MIRROR"
  $SUDO mkdir -p /etc/docker
  if need jq && [ -s /etc/docker/daemon.json ]; then
    TMPJ="$(mktemp)"; jq --arg m "$DOCKER_MIRROR" '. + {"registry-mirrors":[$m]}' /etc/docker/daemon.json >"$TMPJ" 2>/dev/null && $SUDO cp "$TMPJ" /etc/docker/daemon.json; rm -f "$TMPJ"
  else
    echo "{\"registry-mirrors\":[\"$DOCKER_MIRROR\"]}" | $SUDO tee /etc/docker/daemon.json >/dev/null
  fi
  $SUDO systemctl restart docker >/dev/null 2>&1 || $SUDO service docker restart >/dev/null 2>&1 || true
  sleep 2
fi
say "Pulling $NATS_IMAGE"
$SUDO docker pull "$NATS_IMAGE" || { echo "!! image pull failed — set DOCKER_MIRROR=https://docker.m.daocloud.io (or your registry mirror) and re-run."; exit 1; }

$SUDO mkdir -p "$NATS_DIR/tls" "$NATS_DIR/jwt"

# ── 3. TLS cert ──────────────────────────────────────────────────────────────
CERT="$NATS_DIR/tls/cert.pem"; KEY="$NATS_DIR/tls/key.pem"
if [ "$TLS" = "existing" ]; then
  CERT="${CERT_FILE:?TLS=existing requires CERT_FILE=/path/fullchain.pem}"
  KEY="${KEY_FILE:?TLS=existing requires KEY_FILE=/path/privkey.pem}"
  { [ -f "$CERT" ] && [ -f "$KEY" ]; } || { echo "CERT_FILE/KEY_FILE not found"; exit 1; }
  say "Using existing certificate $CERT"
elif [ "$TLS" = "letsencrypt" ]; then
  [ -n "$DOMAIN" ] || { echo "letsencrypt requires DOMAIN=..."; exit 1; }
  say "Obtaining cert for $DOMAIN (needs DNS A record → here + port 80 free)"
  ensure certbot
  $SUDO certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --keep-until-expiring
  CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
else
  ensure openssl
  say "Generating self-signed cert for $HOST_ADDR"
  SAN=$([ -n "$DOMAIN" ] && echo "DNS:$DOMAIN" || echo "IP:$HOST_ADDR")
  $SUDO openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CERT" -days 825 -subj "/CN=$HOST_ADDR" -addext "subjectAltName=$SAN"
fi

# ── 4. server config ─────────────────────────────────────────────────────────
say "Writing $NATS_DIR/nats-server.conf"
$SUDO tee "$NATS_DIR/nats-server.conf" >/dev/null <<EOF
host: "0.0.0.0"
port: $PORT
tls { cert_file: "$CERT", key_file: "$KEY" }
websocket { port: $WS_PORT, tls { cert_file: "$CERT", key_file: "$KEY" } }
max_payload: 8MB
include "resolver.conf"
EOF
[ -f "$NATS_DIR/resolver.conf" ] || echo "# placeholder until nsc generates it" | $SUDO tee "$NATS_DIR/resolver.conf" >/dev/null

# ── 5. decentralized JWT accounts (MEMORY resolver, no push) ──────────────────
ACCOUNT_ID=""; ACCOUNT_SEED=""
if [ "$SKIP_NSC" != "1" ]; then
  say "Configuring decentralized JWT (operator/SYS/APP + MEMORY resolver)"
  export NKEYS_PATH="${NKEYS_PATH:-$HOME/.local/share/nats/nsc/keys}"
  nsc describe operator DP >/dev/null 2>&1 || nsc add operator --generate-signing-key --sys --name DP
  nsc edit operator --require-signing-keys >/dev/null 2>&1 || true
  nsc describe account APP >/dev/null 2>&1 || nsc add account APP
  SKN="$(nsc describe account APP -J 2>/dev/null | jq -r '(.nats.signing_keys // []) | length')"
  [ "${SKN:-0}" -ge 1 ] || nsc edit account APP --sk generate
  nsc generate config --mem-resolver --sys-account SYS | $SUDO tee "$NATS_DIR/resolver.conf" >/dev/null
fi

# ── 6. run the container (boot autostart) ────────────────────────────────────
say "Starting nats container (restart=unless-stopped → boot autostart)"
MOUNTS=(-v "$NATS_DIR:$NATS_DIR")
case "$CERT" in
  "$NATS_DIR"/*) : ;;
  /etc/letsencrypt/*) MOUNTS+=(-v "/etc/letsencrypt:/etc/letsencrypt:ro") ;;
  *) MOUNTS+=(-v "$(dirname "$CERT"):$(dirname "$CERT"):ro") ;;
esac
$SUDO docker rm -f nats >/dev/null 2>&1 || true
$SUDO docker run -d --name nats --restart unless-stopped -u 0:0 \
  -p "$PORT:$PORT" -p "$WS_PORT:$WS_PORT" "${MOUNTS[@]}" \
  "$NATS_IMAGE" -c "$NATS_DIR/nats-server.conf"
sleep 2
$SUDO docker ps --filter name=nats --format '   {{.Names}}  {{.Status}}  {{.Ports}}' || true

# ── 7. firewall ──────────────────────────────────────────────────────────────
if need ufw; then $SUDO ufw allow "$PORT/tcp" >/dev/null 2>&1 || true; $SUDO ufw allow "$WS_PORT/tcp" >/dev/null 2>&1 || true
elif need firewall-cmd; then $SUDO firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 || true; $SUDO firewall-cmd --permanent --add-port="$WS_PORT/tcp" >/dev/null 2>&1 || true; $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
else say "No ufw/firewalld — open ports $PORT and $WS_PORT (also in your cloud security group)."; fi

# ── 8. extract creds + summary ───────────────────────────────────────────────
if [ "$SKIP_NSC" != "1" ]; then
  set +e
  ACCOUNT_ID="$(nsc describe account APP -J 2>/dev/null | jq -r '.sub // empty')"
  SK_PUB="$(nsc describe account APP -J 2>/dev/null | jq -r '(.nats.signing_keys[0] | if type=="object" then .key else . end) // empty')"
  if [ -n "$SK_PUB" ]; then NK="$(find "${NKEYS_PATH:-$HOME/.local/share/nats/nsc/keys}" -name "${SK_PUB}.nk" 2>/dev/null | head -1)"; [ -n "$NK" ] && ACCOUNT_SEED="$(cat "$NK" 2>/dev/null)"; fi
  set -e
fi

URL="tls://${HOST_ADDR}:${PORT}"; SUMMARY="$HOME/desktop-proxy-remote.json"
{
  echo "{"; echo "  \"remote\": {"; echo "    \"enabled\": true,"; echo "    \"url\": \"$URL\","
  [ -n "$ACCOUNT_SEED" ] && echo "    \"accountSeed\": \"$ACCOUNT_SEED\","
  [ -n "$ACCOUNT_ID" ]   && echo "    \"accountId\": \"$ACCOUNT_ID\""
  [ "$TLS" = "selfsigned" ] && echo "    , \"caFile\": \"<copy $CERT onto the desktop, set its path here>\""
  echo "  }"; echo "}"
} | tee "$SUMMARY"

cat <<EOF

==> Done. NATS runs in Docker with boot autostart (TLS=$TLS).
    Paste the "remote" block above into each desktop's ~/.desktop-proxy/config.json,
    restart the app, then run "dprox pair" on the desktop to add a phone.
    (Saved to $SUMMARY)   Logs: docker logs nats   Status: docker ps
EOF
if [ "$SKIP_NSC" != "1" ] && { [ -z "$ACCOUNT_ID" ] || [ -z "$ACCOUNT_SEED" ]; }; then
  cat <<'EOF'

!! Could not auto-extract account credentials. Get them manually:
   accountId:   nsc describe account APP -J | jq -r .sub
   signingKey:  nsc describe account APP -J | jq -r '.nats.signing_keys[0] | if type=="object" then .key else . end'
   accountSeed: find ~/.local/share/nats/nsc/keys -name "<signingKey>.nk" -exec cat {} \;
EOF
fi
