#!/usr/bin/env bash
#
# One-click NATS server setup for the desktop-proxy remote bus.
#
# Online install (run on the SERVER as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/normojs/desktop-proxy/main/scripts/nats-setup.sh -o nats-setup.sh
#   sudo DOMAIN=nats.example.com TLS=letsencrypt PM=systemd bash nats-setup.sh
#   # quick self-signed test (no domain):
#   curl -fsSL https://raw.githubusercontent.com/normojs/desktop-proxy/main/scripts/nats-setup.sh | sudo bash
#
# It installs nats-server + nsc, makes a TLS cert, configures decentralized JWT
# auth (operator/SYS/APP + nats-resolver), enables autostart, opens the firewall,
# and PRINTS the values to paste into each desktop's ~/.desktop-proxy/config.json.
# After this, adding desktops/phones needs NO further server operation.
#
# Vars: DOMAIN(optional) TLS=letsencrypt|selfsigned(default) PM=systemd|pm2|docker(default systemd)
#       PORT(4222) WS_PORT(8443) VER(nats-server ver) NATS_DIR(/etc/nats)
#       SKIP_NSC=1 skip account automation; FORCE_INSTALL=1 re-download binaries
# China network helpers:
#       PROXY=http://127.0.0.1:7890   route downloads through a proxy
#       GH_MIRROR=https://ghproxy.com/  prefix for github.com downloads (note trailing /)
# Safe to re-run (idempotent): existing nats-server/nsc accounts are reused.

set -euo pipefail

TLS="${TLS:-selfsigned}"; PM="${PM:-systemd}"; PORT="${PORT:-4222}"; WS_PORT="${WS_PORT:-8443}"
VER="${VER:-v2.14.1}"; NATS_DIR="${NATS_DIR:-/etc/nats}"; DOMAIN="${DOMAIN:-}"; SKIP_NSC="${SKIP_NSC:-0}"
PROXY="${PROXY:-}"; GH_MIRROR="${GH_MIRROR:-}"; FORCE_INSTALL="${FORCE_INSTALL:-0}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
HOST_ADDR="${DOMAIN:-$(hostname -I 2>/dev/null | awk '{print $1}')}"

arch() { case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; *) echo amd64;; esac; }
need() { command -v "$1" >/dev/null 2>&1; }
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
CURL_OPTS=(-fL --retry 3 --retry-delay 2 --connect-timeout 20)
[ -n "$PROXY" ] && CURL_OPTS+=(--proxy "$PROXY")
ghurl() { case "$1" in https://github.com/*|https://raw.githubusercontent.com/*) echo "${GH_MIRROR}$1";; *) echo "$1";; esac; }
DEFAULT_MIRRORS=("https://ghfast.top/" "https://ghproxy.net/" "https://gh-proxy.com/")
dl() { # dl <url> <out>; tries direct (or GH_MIRROR), then auto-falls back to mirrors for github URLs
  local raw="$1" out="$2"
  say "Downloading $(ghurl "$raw")"
  curl "${CURL_OPTS[@]}" --progress-bar -o "$out" "$(ghurl "$raw")" && return 0
  if [ -z "$GH_MIRROR" ]; then case "$raw" in https://github.com/*|https://raw.githubusercontent.com/*)
    for m in "${DEFAULT_MIRRORS[@]}"; do
      say "Direct download failed — retry via mirror ${m}"
      curl "${CURL_OPTS[@]}" --progress-bar -o "$out" "${m}${raw}" && return 0
    done;; esac
  fi
  return 1
}

say "desktop-proxy NATS one-click setup (TLS=$TLS, PM=$PM, host=$HOST_ADDR${PROXY:+, proxy=$PROXY}${GH_MIRROR:+, mirror=$GH_MIRROR})"

# ── 1. install nats-server, nsc, jq ──────────────────────────────────────────
if ! need nats-server || [ "$FORCE_INSTALL" = "1" ]; then
  say "Installing nats-server $VER"
  TMP="$(mktemp -d)"
  dl "https://github.com/nats-io/nats-server/releases/download/${VER}/nats-server-${VER}-linux-$(arch).tar.gz" "$TMP/n.tgz"
  tar -xzf "$TMP/n.tgz" -C "$TMP"; $SUDO install "$TMP"/nats-server-*/nats-server /usr/local/bin/nats-server; rm -rf "$TMP"
else
  say "nats-server already installed ($(nats-server --version 2>/dev/null)) — skipping (FORCE_INSTALL=1 to reinstall)"
fi
if [ "$SKIP_NSC" != "1" ] && { ! need nsc || [ "$FORCE_INSTALL" = "1" ]; }; then
  need unzip || $SUDO apt-get install -y unzip >/dev/null 2>&1 || true
  dl "https://github.com/nats-io/nsc/releases/latest/download/nsc-linux-$(arch).zip" /tmp/nsc.zip
  $SUDO unzip -o /tmp/nsc.zip -d /usr/local/bin >/dev/null
fi
need jq || $SUDO apt-get install -y jq >/dev/null 2>&1 || true

$SUDO mkdir -p "$NATS_DIR/tls" "$NATS_DIR/jwt"

# ── 2. TLS cert ──────────────────────────────────────────────────────────────
CERT="$NATS_DIR/tls/cert.pem"; KEY="$NATS_DIR/tls/key.pem"
if [ "$TLS" = "letsencrypt" ]; then
  [ -n "$DOMAIN" ] || { echo "letsencrypt requires DOMAIN=..."; exit 1; }
  say "Obtaining cert for $DOMAIN — needs DNS A record → this server and port 80 reachable"
  need ufw && { $SUDO ufw allow 80/tcp >/dev/null 2>&1 || true; }
  need certbot || $SUDO apt-get install -y certbot
  # --keep-until-expiring makes re-runs reuse the existing cert (no rate-limit hit).
  $SUDO certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --keep-until-expiring
  CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
else
  say "Generating self-signed cert for $HOST_ADDR"
  SAN=$([ -n "$DOMAIN" ] && echo "DNS:$DOMAIN" || echo "IP:$HOST_ADDR")
  $SUDO openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CERT" -days 825 \
    -subj "/CN=$HOST_ADDR" -addext "subjectAltName=$SAN"
fi

# ── 3. base server config ────────────────────────────────────────────────────
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

# ── 4. decentralized JWT accounts (nsc) ──────────────────────────────────────
ACCOUNT_ID=""; ACCOUNT_SEED=""
if [ "$SKIP_NSC" != "1" ]; then
  say "Configuring decentralized JWT (operator/SYS/APP + nats-resolver)"
  export NKEYS_PATH="${NKEYS_PATH:-$HOME/.local/share/nats/nsc/keys}"
  # Idempotent: only create operator/account if missing, so re-runs keep the
  # SAME keys (existing desktops/phones stay valid).
  nsc describe operator DP >/dev/null 2>&1 || nsc add operator --generate-signing-key --sys --name DP
  nsc edit operator --require-signing-keys --account-jwt-server-url "nats://127.0.0.1:$PORT" >/dev/null 2>&1 || true
  nsc describe account APP >/dev/null 2>&1 || nsc add account APP
  SKN="$(nsc describe account APP -J 2>/dev/null | jq -r '(.nats.signing_keys // []) | length')"
  [ "${SKN:-0}" -ge 1 ] || nsc edit account APP --sk generate
  nsc generate config --nats-resolver --sys-account SYS | $SUDO tee "$NATS_DIR/resolver.conf" >/dev/null
fi

# ── 5. autostart ─────────────────────────────────────────────────────────────
start_systemd() {
  $SUDO tee /etc/systemd/system/nats.service >/dev/null <<EOF
[Unit]
Description=NATS Server (desktop-proxy)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/nats-server -c $NATS_DIR/nats-server.conf
Restart=always
RestartSec=2
LimitNOFILE=100000
[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload; $SUDO systemctl enable --now nats; $SUDO systemctl restart nats
}
start_pm2() {
  need pm2 || $SUDO npm install -g pm2
  pm2 delete nats >/dev/null 2>&1 || true
  pm2 start /usr/local/bin/nats-server --name nats -- -c "$NATS_DIR/nats-server.conf"
  pm2 save; pm2 startup | tail -1 || true
}
start_docker() {
  $SUDO docker rm -f nats >/dev/null 2>&1 || true
  $SUDO docker run -d --name nats --restart unless-stopped -p "$PORT:$PORT" -p "$WS_PORT:$WS_PORT" \
    -v "$NATS_DIR:$NATS_DIR" nats:2.14 -c "$NATS_DIR/nats-server.conf"
}
say "Starting nats-server via $PM (boot autostart)"
case "$PM" in systemd) start_systemd;; pm2) start_pm2;; docker) start_docker;; *) echo "bad PM=$PM"; exit 1;; esac

# ── 6. firewall ──────────────────────────────────────────────────────────────
if need ufw; then $SUDO ufw allow "$PORT/tcp" >/dev/null 2>&1 || true; $SUDO ufw allow "$WS_PORT/tcp" >/dev/null 2>&1 || true; fi

# ── 7. push accounts + extract desktop credentials ───────────────────────────
if [ "$SKIP_NSC" != "1" ]; then
  sleep 2
  nsc push -A >/dev/null 2>&1 || nsc push -A || true
  set +e
  ACCOUNT_ID="$(nsc describe account APP -J 2>/dev/null | jq -r '.sub // empty')"
  SK_PUB="$(nsc describe account APP -J 2>/dev/null | jq -r '(.nats.signing_keys[0].key // .nats.signing_keys[0]) // empty')"
  if [ -n "$SK_PUB" ]; then
    NK="$(find "${NKEYS_PATH:-$HOME/.local/share/nats/nsc/keys}" -name "${SK_PUB}.nk" 2>/dev/null | head -1)"
    [ -n "$NK" ] && ACCOUNT_SEED="$(cat "$NK" 2>/dev/null)"
  fi
  set -e
fi

# ── 8. summary ───────────────────────────────────────────────────────────────
URL="tls://${HOST_ADDR}:${PORT}"
SUMMARY="$HOME/desktop-proxy-remote.json"
{
  echo "{"
  echo "  \"remote\": {"
  echo "    \"enabled\": true,"
  echo "    \"url\": \"$URL\","
  [ -n "$ACCOUNT_SEED" ] && echo "    \"accountSeed\": \"$ACCOUNT_SEED\","
  [ -n "$ACCOUNT_ID" ]   && echo "    \"accountId\": \"$ACCOUNT_ID\""
  [ "$TLS" = "selfsigned" ] && echo "    , \"caFile\": \"<copy $CERT onto the desktop and put its path here>\""
  echo "  }"
  echo "}"
} | tee "$SUMMARY"

cat <<EOF

==> Done. NATS is running with autostart ($PM), TLS=$TLS.
    Paste the "remote" block above into each desktop's ~/.desktop-proxy/config.json,
    restart the app, then run "desktop-proxy pair" on the desktop to add a phone.
    (Saved to $SUMMARY)
EOF
if [ "$SKIP_NSC" != "1" ] && { [ -z "$ACCOUNT_ID" ] || [ -z "$ACCOUNT_SEED" ]; }; then
  cat <<'EOF'

!! Could not auto-extract account credentials (nsc version differences). Get them manually:
   accountId:   nsc describe account APP -J | jq -r .sub
   signingKey:  nsc describe account APP -J | jq -r '.nats.signing_keys[0].key // .nats.signing_keys[0]'
   accountSeed: find ~/.local/share/nats/nsc/keys -name "<signingKey>.nk" -exec cat {} \;
EOF
fi
