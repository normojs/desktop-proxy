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

# Binaries install to /usr/local/bin — ensure it's on PATH (RHEL/sudo shells often omit it).
export PATH="/usr/local/bin:/usr/local/sbin:$PATH"

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

# ── package manager (apt/dnf/yum/zypper/pacman/apk) + dependency installer ────
PM_INSTALL=""; APT_UPDATED=0
if   need apt-get; then PM_INSTALL="apt-get install -y"
elif need dnf;     then PM_INSTALL="dnf install -y"
elif need yum;     then PM_INSTALL="yum install -y"
elif need zypper;  then PM_INSTALL="zypper install -y"
elif need pacman;  then PM_INSTALL="pacman -S --noconfirm"
elif need apk;     then PM_INSTALL="apk add --no-cache"
fi
pkg_install() {
  [ -n "$PM_INSTALL" ] || { echo "!! No supported package manager. Please install manually: $*"; return 1; }
  if [ "${PM_INSTALL%% *}" = "apt-get" ] && [ "$APT_UPDATED" = "0" ]; then $SUDO apt-get update -y >/dev/null 2>&1 || true; APT_UPDATED=1; fi
  $SUDO $PM_INSTALL "$@"
}
ensure() { # ensure <command> [package]
  local cmd="$1" pkg="${2:-$1}"
  need "$cmd" && return 0
  say "Installing dependency: $pkg"
  pkg_install "$pkg" || { echo "!! Could not auto-install '$pkg'. Install it and re-run."; exit 1; }
  need "$cmd" || { echo "!! '$cmd' still missing after install."; exit 1; }
}

say "desktop-proxy NATS one-click setup (TLS=$TLS, PM=$PM, host=$HOST_ADDR${PROXY:+, proxy=$PROXY}${GH_MIRROR:+, mirror=$GH_MIRROR})"
if [ -n "$PM_INSTALL" ]; then say "Package manager: ${PM_INSTALL%% *}"; else say "No package manager detected — ensure curl/tar/unzip/jq/openssl are preinstalled"; fi

# ── 1. dependencies + nats-server + nsc ──────────────────────────────────────
ensure curl; ensure tar
if ! need nats-server || [ "$FORCE_INSTALL" = "1" ]; then
  say "Installing nats-server $VER"
  TMP="$(mktemp -d)"
  dl "https://github.com/nats-io/nats-server/releases/download/${VER}/nats-server-${VER}-linux-$(arch).tar.gz" "$TMP/n.tgz" \
    || { echo "!! nats-server download failed — retry with PROXY=http://host:port or GH_MIRROR=https://ghfast.top/"; exit 1; }
  tar -xzf "$TMP/n.tgz" -C "$TMP" 2>/dev/null \
    || { echo "!! extract failed — the download isn't a valid tarball (a mirror may have returned an error page). Try another GH_MIRROR= or PROXY=, or set VER= to a valid release."; exit 1; }
  BIN="$(find "$TMP" -type f -name nats-server | head -1)"
  [ -n "$BIN" ] || { echo "!! nats-server binary not found inside the archive"; exit 1; }
  $SUDO install "$BIN" /usr/local/bin/nats-server
  rm -rf "$TMP"
else
  say "nats-server present ($(nats-server --version 2>/dev/null)); FORCE_INSTALL=1 to reinstall"
fi
{ [ -x /usr/local/bin/nats-server ] || need nats-server; } || { echo "!! nats-server not installed"; exit 1; }

if [ "$SKIP_NSC" != "1" ]; then
  ensure jq; ensure unzip
  if ! need nsc || [ "$FORCE_INSTALL" = "1" ]; then
    say "Installing nsc"
    dl "https://github.com/nats-io/nsc/releases/latest/download/nsc-linux-$(arch).zip" /tmp/nsc.zip \
      || { echo "!! nsc download failed — retry with PROXY=... or GH_MIRROR=https://ghfast.top/"; exit 1; }
    $SUDO unzip -o /tmp/nsc.zip -d /usr/local/bin >/dev/null \
      || { echo "!! nsc unzip failed — the download isn't a valid zip (mirror returned an error page?). Try another GH_MIRROR=/PROXY=."; exit 1; }
  fi
  { [ -x /usr/local/bin/nsc ] || need nsc; } || { echo "!! nsc not installed (is /usr/local/bin writable?)"; exit 1; }
fi

$SUDO mkdir -p "$NATS_DIR/tls" "$NATS_DIR/jwt"

# ── 2. TLS cert ──────────────────────────────────────────────────────────────
CERT="$NATS_DIR/tls/cert.pem"; KEY="$NATS_DIR/tls/key.pem"
if [ "$TLS" = "existing" ]; then
  # Reuse a cert you already obtained (recommended when the box already runs
  # nginx/web on 80/443 — no standalone, no conflict). Set CERT_FILE + KEY_FILE.
  CERT="${CERT_FILE:?TLS=existing requires CERT_FILE=/path/fullchain.pem}"
  KEY="${KEY_FILE:?TLS=existing requires KEY_FILE=/path/privkey.pem}"
  { [ -f "$CERT" ] && [ -f "$KEY" ]; } || { echo "CERT_FILE/KEY_FILE not found"; exit 1; }
  say "Using existing certificate $CERT"
elif [ "$TLS" = "letsencrypt" ]; then
  [ -n "$DOMAIN" ] || { echo "letsencrypt requires DOMAIN=..."; exit 1; }
  say "Obtaining cert for $DOMAIN — needs DNS A record → this server and port 80 reachable"
  say "NOTE: --standalone needs port 80 FREE. If nginx/web uses 80, stop it briefly or use TLS=existing instead."
  need ufw && { $SUDO ufw allow 80/tcp >/dev/null 2>&1 || true; }
  ensure certbot   # on RHEL/CentOS this may need EPEL: sudo dnf install -y epel-release
  # --keep-until-expiring makes re-runs reuse the existing cert (no rate-limit hit).
  $SUDO certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --keep-until-expiring
  CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
else
  ensure openssl
  say "Generating self-signed cert for $HOST_ADDR"
  SAN=$([ -n "$DOMAIN" ] && echo "DNS:$DOMAIN" || echo "IP:$HOST_ADDR")
  $SUDO openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CERT" -days 825 \
    -subj "/CN=$HOST_ADDR" -addext "subjectAltName=$SAN"
  # Trust the self-signed CA system-wide so `nsc push` (TLS) validates.
  if [ -d /etc/pki/ca-trust/source/anchors ]; then
    $SUDO cp "$CERT" /etc/pki/ca-trust/source/anchors/dp-nats.crt && $SUDO update-ca-trust extract >/dev/null 2>&1 || true
  elif [ -d /usr/local/share/ca-certificates ]; then
    $SUDO cp "$CERT" /usr/local/share/ca-certificates/dp-nats.crt && $SUDO update-ca-certificates >/dev/null 2>&1 || true
  fi
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
  # Push over TLS using an address the cert covers (domain for LE; the public IP
  # for self-signed, which we add to its SAN) — pushing to 127.0.0.1 fails TLS.
  JWT_URL="tls://${DOMAIN:-$HOST_ADDR}:$PORT"
  nsc edit operator --require-signing-keys --account-jwt-server-url "$JWT_URL" >/dev/null 2>&1 || true
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

# ── 6. firewall (ufw or firewalld) ───────────────────────────────────────────
if need ufw; then
  $SUDO ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  $SUDO ufw allow "$WS_PORT/tcp" >/dev/null 2>&1 || true
elif need firewall-cmd; then
  $SUDO firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 || true
  $SUDO firewall-cmd --permanent --add-port="$WS_PORT/tcp" >/dev/null 2>&1 || true
  $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
else
  say "No ufw/firewalld detected — make sure ports $PORT and $WS_PORT are open (also in your cloud security group)."
fi

# ── 7. push accounts + extract desktop credentials ───────────────────────────
if [ "$SKIP_NSC" != "1" ]; then
  sleep 2
  say "Pushing accounts to the resolver (tls://${DOMAIN:-$HOST_ADDR}:$PORT)"
  nsc push -A || { sleep 2; nsc push -A; } || \
    say "WARNING: nsc push failed — accounts not uploaded; desktops won't authenticate. Ensure tls://${DOMAIN:-$HOST_ADDR}:$PORT is reachable from THIS host (DNS + port + valid cert), then run: nsc push -A"
  set +e
  ACCOUNT_ID="$(nsc describe account APP -J 2>/dev/null | jq -r '.sub // empty')"
  # signing_keys[0] may be a plain string or an object {key:...} depending on nsc version.
  SK_PUB="$(nsc describe account APP -J 2>/dev/null | jq -r '(.nats.signing_keys[0] | if type=="object" then .key else . end) // empty')"
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
