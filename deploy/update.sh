#!/usr/bin/env bash
#
# Pull the latest release and restart. Run ON THE SERVER as root:
#   sudo bash /opt/pharmacypos/deploy/update.sh
#
# Takes a labelled backup first, and rolls back if the new build fails to
# become healthy — a broken deploy must not leave the counter unable to bill.

set -euo pipefail

APP_DIR=/opt/pharmacypos
BRANCH="${PHARMACY_BRANCH:-main}"
APP_USER=pharmacy

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 2; }

cd "$APP_DIR"
PREVIOUS=$(git rev-parse HEAD)

echo "==> Backing up before the update"
sudo -u "$APP_USER" bash -c 'set -a; . /etc/pharmacypos.env; set +a; node server/dist/backup-cli.js --label pre-update'

echo "==> Fetching $BRANCH"
git fetch --depth 1 origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> Building"
npm ci                     # build tools live in devDependencies
npm run build
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Restarting"
systemctl restart pharmacypos

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    echo "Update complete: $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done

echo "!! The new build is not healthy — rolling back to ${PREVIOUS:0:7}" >&2
git reset --hard "$PREVIOUS"
npm ci
npm run build
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
systemctl restart pharmacypos
echo "Rolled back. Check: journalctl -u pharmacypos -n 50" >&2
exit 1
