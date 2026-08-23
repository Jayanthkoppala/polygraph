#!/usr/bin/env bash
# One-time provisioning for the polygraph-staging VM. Blocked as of
# 2026-08-23 on the boss-media-505616 GCP billing account being closed
# (`gcloud billing accounts describe 01A393-2E19E5-17D3E8` -> open: false).
# All `gcloud compute *.create` calls 403 with a "billing not enabled"
# message until that's reopened, even though the project's own
# billingEnabled flag reads true and the existing prod VM keeps running.
# Re-run this end to end once billing is confirmed open again.
set -euo pipefail

PROJECT="boss-media-505616"
ZONE="us-central1-a"
REGION="us-central1"
VM="polygraph-staging"

# 1. Static external IP (so the sslip.io hostname is stable across reboots).
gcloud compute addresses create polygraph-staging-ip --project "$PROJECT" --region "$REGION"
IP="$(gcloud compute addresses describe polygraph-staging-ip --project "$PROJECT" --region "$REGION" --format='value(address)')"
HOSTNAME="${IP}.sslip.io"
echo "staging hostname: $HOSTNAME"

# 2. Data disk, same device-name as prod so the startup script's disk logic
#    (by-id/google-polygraph-data) works unmodified.
gcloud compute disks create polygraph-staging-data --project "$PROJECT" --zone "$ZONE" \
  --size 10GB --type pd-standard

# 3. Instance. debian-12, e2-small, default SA (no Secret Manager access
#    needed — deploy.sh supplies the env file directly), polygraph-web tag
#    reuses the existing 80/443 firewall rule.
gcloud compute instances create "$VM" \
  --project "$PROJECT" --zone "$ZONE" \
  --machine-type e2-small \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 25GB --boot-disk-type pd-standard \
  --disk "name=polygraph-staging-data,device-name=polygraph-data,mode=rw" \
  --address "$IP" \
  --tags polygraph-web \
  --metadata-from-file startup-script="$(dirname "$0")/staging-startup.sh" \
  --metadata "polygraph-hostname=${HOSTNAME}"

echo "Created $VM at https://${HOSTNAME}"
echo "Next: bash deploy/deploy.sh $VM 3d13ab9   # after writing ~/polygraph-runtime-${VM}.env (see deploy/README.md)"
