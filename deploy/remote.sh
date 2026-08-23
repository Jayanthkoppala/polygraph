#!/usr/bin/env bash
# Remote exec/copy wrapper for the Polygraph VMs only (allowlisted by name).
# Usage: bash deploy/remote.sh <vm> exec '<command>'
#        bash deploy/remote.sh <vm> put <local-path> <remote-path>
#        bash deploy/remote.sh <vm> get <remote-path> <local-path>
set -euo pipefail
PROJECT="boss-media-505616"
ZONE="us-central1-a"
ALLOWED="polygraph-fifteenth-morning polygraph-staging"
vm="${1:?vm name}"; op="${2:?exec|put|get}"; shift 2
case " $ALLOWED " in *" $vm "*) ;; *) echo "refusing: $vm is not an allowlisted Polygraph VM" >&2; exit 2;; esac
case "$op" in
  exec) gcloud compute ssh "$vm" --project "$PROJECT" --zone "$ZONE" --quiet --command "$1" ;;
  put)  gcloud compute scp --recurse "$1" "$vm:$2" --project "$PROJECT" --zone "$ZONE" --quiet ;;
  get)  gcloud compute scp --recurse "$vm:$1" "$2" --project "$PROJECT" --zone "$ZONE" --quiet ;;
  *) echo "unknown op $op" >&2; exit 2 ;;
esac
