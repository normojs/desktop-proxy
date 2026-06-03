#!/usr/bin/env bash
#
# Convenience installer for the desktop-proxy remote bus NATS server.
# Handles: install nats-server, TLS cert (Let's Encrypt or self-signed),
# nats-server.conf, autostart (systemd | pm2 | docker), and firewall.
#
# It does NOT run `nsc` (account/identity keys are sensitive) — it prints the
# one-time account commands at the end. See docs/nats-deploy.md.
#
# Usage (env vars):
#   DOMAIN=nats.example.com TLS=letsencrypt PM=systemd ./scripts/nats-setup.sh
#   TLS=selfsigned PM=pm2  ./scripts/nats-setup.sh           # no domain
#   PM=docker DOMAIN=nats.example.com TLS=letsencrypt ./scripts/nats-setup.sh
#
# Vars: DOMAIN(optional) TLS=letsencrypt|selfsigned(default) PM=systemd|pm2|docker(default systemd)
#       PORT(4222) WS_PORT(8443) VER(nats-server version) NATS_DIR(/etc/nats)

set -euo pipefail

TLS="${TLS:-selfsigned}"
PM="${PM:-systemd}"
PORT="${PORT:-4222}"
WS_PORT="${WS_PORT:-8443}"
VER="${VER:-v2.14.1}"
NATS_DIR="${NATS_DIR:-/etc/nats}"
DOMAIN="${DOMAIN:-}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

arch() { case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; *) echo amd64;; esac; }

echo "==> desktop-proxy NATS setup (TLS=$TLS, PM=$PM, domain=${DOMAIN:-none})"

# 1. install nats-server
if ! command -v nats-server >/dev/null 2>&1; then
  echo "==> Installing nats-server $VER"
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/n.tar.gz" "https://github.com/nats-io/nats-server/releases/download/${VER}/nats-server-${VER}-linux-$(arch).tar.gz"
  tar -xzf "$TMP/n.tar.gz" -C "$TMP"
  $SUDO install "$TMP"/nats-server-*/nats-server /usr/local/bin/nats-server
  rm -rf "$TMP"
fi
nats-server --version

$SUDO mkdir -p "$NATS_DIR/tls" "$NATS_DIR/jwt"

# 2. TLS cert
CERT="$NATS_DIR/tls/cert.pem"; KEY="$NATS_DIR/tls/key.pem"
if [ "$TLS" = "letsencrypt" ]; then
  [ -n "$DOMAIN" ] || { echo "letsencrypt requires DOMAIN=..."; exit 1; }
  command -v certbot >/dev/null 2>&1 || $SUDO apt-get install -y certbot
  $SUDO certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || true
  CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
else
  CN="${DOMAIN:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
  echo "==> Generating self-signed cert for CN=$CN"
  $SUDO openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CERT" -days 825 \
    -subj "/CN=$CN" -addext "subjectAltName=$( [ -n "$DOMAIN" ] && echo DNS:$DOMAIN || echo IP:$CN )"
  echo "==> Self-signed CA is $CERT — copy it to each desktop and set remote.caFile to its path."
fi

# 3. nats-server.conf
echo "==> Writing $NATS_DIR/nats-server.conf"
$SUDO tee "$NATS_DIR/nats-server.conf" >/dev/null <<EOF
host: "0.0.0.0"
port: $PORT
tls {
  cert_file: "$CERT"
  key_file:  "$KEY"
}
websocket {
  port: $WS_PORT
  tls {
    cert_file: "$CERT"
    key_file:  "$KEY"
  }
}
max_payload: 8MB
# Decentralized auth: after running the nsc commands printed below, this include
# brings in the operator + SYS account + nats-resolver.
include "resolver.conf"
EOF
# Placeholder resolver.conf so the server can start before nsc is run.
[ -f "$NATS_DIR/resolver.conf" ] || echo "# replaced by: nsc generate config --nats-resolver --sys-account SYS" | $SUDO tee "$NATS_DIR/resolver.conf" >/dev/null

# 4. autostart
case "$PM" in
  systemd)
    echo "==> Installing systemd unit (boot autostart)"
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
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now nats
    $SUDO systemctl status nats --no-pager || true
    ;;
  pm2)
    echo "==> Starting via pm2 (boot autostart)"
    command -v pm2 >/dev/null 2>&1 || $SUDO npm install -g pm2
    pm2 start /usr/local/bin/nats-server --name nats -- -c "$NATS_DIR/nats-server.conf"
    pm2 save
    pm2 startup | tail -1 || true   # run the printed command once to enable boot autostart
    echo "    (If pm2 printed a 'sudo env ... pm2 startup ...' command above, run it once.)"
    ;;
  docker)
    echo "==> Starting via docker (restart=unless-stopped → boot autostart)"
    $SUDO docker rm -f nats 2>/dev/null || true
    $SUDO docker run -d --name nats --restart unless-stopped \
      -p "$PORT:$PORT" -p "$WS_PORT:$WS_PORT" \
      -v "$NATS_DIR:$NATS_DIR" nats:2.14 -c "$NATS_DIR/nats-server.conf"
    ;;
  *) echo "Unknown PM=$PM (use systemd|pm2|docker)"; exit 1;;
esac

# 5. firewall
if command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow "$PORT/tcp" || true
  $SUDO ufw allow "$WS_PORT/tcp" || true
fi

cat <<EOF

==> Server process is up. One-time account setup (run on a machine with nsc):

  nsc add operator --generate-signing-key --sys --name DP
  nsc edit operator --require-signing-keys --account-jwt-server-url "nats://127.0.0.1:$PORT"
  nsc add account APP
  nsc edit account APP --sk generate
  nsc generate config --nats-resolver --sys-account SYS | $SUDO tee $NATS_DIR/resolver.conf
  $SUDO systemctl restart nats   # or: pm2 restart nats / docker restart nats
  nsc push -A

Then copy these into each desktop's ~/.desktop-proxy/config.json under "remote":
  url:         tls://${DOMAIN:-YOUR_HOST}:$PORT   (or wss://${DOMAIN:-YOUR_HOST}:$WS_PORT)
  accountId:   \$(nsc describe account APP -J | jq -r .sub)
  accountSeed: <APP signing-key SEED, see docs/nats-deploy.md A6>
$( [ "$TLS" = "selfsigned" ] && echo "  caFile:      <path to $CERT copied onto the desktop>" )

See docs/nats-deploy.md for details.
EOF
