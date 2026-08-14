#!/usr/bin/env bash
#
# Create the Google Compute Engine VM that will run PharmacyPOS.
#
# Run this on YOUR machine (not the server), after:
#   gcloud auth login
#   gcloud config set project YOUR-FIREBASE-PROJECT-ID
#
# Usage:
#   bash deploy/create-vm.sh pharmacy.yourdomain.com
#   bash deploy/create-vm.sh pharmacy.yourdomain.com --machine-type e2-micro
#
# Creates a VM with a *static* external IP — a shop's DNS record must not move
# because the machine was restarted. Prints the DNS record to add and the one
# command to run next.

set -euo pipefail

DOMAIN="${1:-}"
shift || true

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${GCP_REGION:-asia-south1}"          # Mumbai — closest to Hyderabad
ZONE="${GCP_ZONE:-${REGION}-a}"
NAME="${VM_NAME:-pharmacypos}"
MACHINE="e2-small"
DISK_GB="${DISK_GB:-20}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --machine-type) MACHINE="$2"; shift 2 ;;
    --zone)         ZONE="$2"; shift 2 ;;
    *)              echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: bash deploy/create-vm.sh pharmacy.yourdomain.com [--machine-type e2-micro]" >&2
  exit 2
fi
if [[ -z "$PROJECT" || "$PROJECT" == "(unset)" ]]; then
  echo "No project set. Run: gcloud config set project YOUR-PROJECT-ID" >&2
  exit 2
fi

echo "Project : $PROJECT"
echo "Zone    : $ZONE"
echo "Machine : $MACHINE"
echo "Domain  : $DOMAIN"
echo

echo "==> Enabling the Compute Engine API (no-op if already on)"
gcloud services enable compute.googleapis.com --project "$PROJECT" --quiet

echo "==> Reserving a static IP"
if ! gcloud compute addresses describe "${NAME}-ip" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute addresses create "${NAME}-ip" --region "$REGION" --project "$PROJECT" --quiet
fi
IP=$(gcloud compute addresses describe "${NAME}-ip" --region "$REGION" --project "$PROJECT" --format='value(address)')
echo "    $IP"

echo "==> Creating the VM"
if gcloud compute instances describe "$NAME" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  echo "    $NAME already exists — leaving it alone"
else
  gcloud compute instances create "$NAME" \
    --project "$PROJECT" \
    --zone "$ZONE" \
    --machine-type "$MACHINE" \
    --image-family ubuntu-2404-lts-amd64 \
    --image-project ubuntu-os-cloud \
    --boot-disk-size "${DISK_GB}GB" \
    --boot-disk-type pd-balanced \
    --address "$IP" \
    --tags http-server,https-server \
    --labels app=pharmacypos \
    --quiet
fi

echo "==> Firewall for HTTP and HTTPS"
for rule in "allow-http:80:http-server" "allow-https:443:https-server"; do
  IFS=: read -r rname rport rtag <<< "$rule"
  if ! gcloud compute firewall-rules describe "$rname" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud compute firewall-rules create "$rname" \
      --project "$PROJECT" --allow "tcp:$rport" --target-tags "$rtag" \
      --description "PharmacyPOS $rname" --quiet
  fi
done
# Deliberately NOT opening 4000: the API is reached through Caddy on 443 only.

cat <<DONE

────────────────────────────────────────────────────────────────
VM is up.

1. Add this DNS record at GoDaddy, then wait for it to resolve:

       Type   Name        Value            TTL
       A      ${DOMAIN%%.*}$(printf '%*s' $((11 - ${#DOMAIN%%.*})) '')$IP      600

   Check with:  dig +short $DOMAIN

2. Connect and install:

       gcloud compute ssh $NAME --zone $ZONE --project $PROJECT

       sudo bash -c 'apt-get update -qq && apt-get install -y -qq git \\
         && git clone --depth 1 https://github.com/NehemyaM/pharmacypos /opt/src \\
         && bash /opt/src/deploy/setup-server.sh $DOMAIN'

3. Open https://$DOMAIN and CHANGE THE DEMO PASSWORDS.
────────────────────────────────────────────────────────────────
DONE
