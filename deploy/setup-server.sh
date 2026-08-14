#!/usr/bin/env bash
#
# One-time setup of a fresh Ubuntu/Debian server to run the PharmacyPOS backend.
#
# Run ON THE SERVER, as root:
#   curl -fsSL https://raw.githubusercontent.com/NehemyaM/pharmacypos/main/deploy/setup-server.sh | bash -s -- api.yourdomain.com
#
# or, having cloned the repo:
#   sudo bash deploy/setup-server.sh api.yourdomain.com
#
# Installs Node, clones the app, builds it, runs it under systemd, and puts
# Caddy in front for automatic HTTPS. Idempotent — safe to re-run.

set -euo pipefail

DOMAIN="${1:-}"
REPO="${PHARMACY_REPO:-https://github.com/NehemyaM/pharmacypos.git}"
BRANCH="${PHARMACY_BRANCH:-main}"
APP_DIR=/opt/pharmacypos
DATA_DIR=/var/lib/pharmacypos
APP_USER=pharmacy

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash deploy/setup-server.sh api.yourdomain.com" >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 2
fi

# A 1 GB e2-micro runs out of memory during the Vite/tsc build and the install
# dies with an unhelpful "Killed". Swap costs nothing and makes the cheap VM
# usable; it is never touched at runtime, since the app idles well under 200 MB.
TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [[ "$TOTAL_MB" -lt 2048 ]] && [[ ! -f /swapfile ]]; then
  echo "==> Only ${TOTAL_MB}MB RAM — adding 2GB of swap so the build can finish"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git build-essential python3 debian-keyring \
  debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy (automatic HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "==> Creating the service user and data directory"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"/backups
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> Fetching the application"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

echo "==> Building"
cd "$APP_DIR"
# The build needs typescript and vite, which are devDependencies, so this
# installs everything. It is deliberately not pruned afterwards: `npm run seed`
# and the test suites run through tsx, which would go with it, and 200MB of
# node_modules is nothing against a 20GB disk.
npm ci
npm run build
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# A JWT secret that survives redeploys. Generated once, readable only by root
# and the service user.
ENV_FILE=/etc/pharmacypos.env
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Generating the JWT secret"
  {
    echo "PHARMACY_DB=$DATA_DIR/pharmacy.sqlite"
    echo "PHARMACY_BACKUP_DIR=$DATA_DIR/backups"
    echo "PHARMACY_JWT_SECRET=$(openssl rand -hex 48)"
    echo "PHARMACY_ALLOWED_ORIGINS=https://${DOMAIN#api.},https://www.${DOMAIN#api.}"
    echo "PORT=4000"
    echo "HOST=127.0.0.1"
    echo "NODE_ENV=production"
  } > "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  chown root:"$APP_USER" "$ENV_FILE"
  echo "    Wrote $ENV_FILE — edit PHARMACY_ALLOWED_ORIGINS if your UI is on a different domain."
fi

echo "==> Installing the systemd service"
# systemd needs an absolute ExecStart, and node is not always at /usr/bin/node
# (nvm, /usr/local, a distro package). Substitute whatever is actually here.
NODE_BIN="$(command -v node)"
echo "    node: $NODE_BIN"
sed "s#^ExecStart=/usr/bin/node#ExecStart=$NODE_BIN#" \
  "$APP_DIR/deploy/pharmacypos.service" > /etc/systemd/system/pharmacypos.service
sed "s#^ExecStart=/usr/bin/node#ExecStart=$NODE_BIN#" \
  "$APP_DIR/deploy/pharmacypos-backup.service" > /etc/systemd/system/pharmacypos-backup.service
chmod 644 /etc/systemd/system/pharmacypos.service /etc/systemd/system/pharmacypos-backup.service
install -m 644 "$APP_DIR/deploy/pharmacypos-backup.timer" /etc/systemd/system/pharmacypos-backup.timer
systemctl daemon-reload
systemctl enable --now pharmacypos.service
systemctl enable --now pharmacypos-backup.timer

echo "==> Configuring Caddy for https://$DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:4000
	log {
		output file /var/log/caddy/pharmacypos.log
	}
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "==> Waiting for the service to answer"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    echo
    echo "PharmacyPOS is running."
    curl -s http://127.0.0.1:4000/api/health; echo
    echo
    echo "Next:"
    echo "  1. Point an A record for $DOMAIN at this server's public IP."
    echo "  2. Seed the demo data (optional):  sudo -u $APP_USER bash -c 'cd $APP_DIR && npm run seed'"
    echo "  3. Open https://$DOMAIN/api/health once DNS has propagated."
    echo "  4. CHANGE THE DEMO PASSWORDS before real billing."
    exit 0
  fi
  sleep 2
done

echo "The service did not become healthy. Check: journalctl -u pharmacypos -n 50" >&2
exit 1
