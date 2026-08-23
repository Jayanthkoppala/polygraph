#!/bin/bash
set -Eeuo pipefail

exec > >(tee -a /var/log/polygraph-startup.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl docker.io git jq
systemctl enable --now docker

data_device="/dev/disk/by-id/google-polygraph-data"
for _ in $(seq 1 30); do
  [ -b "$data_device" ] && break
  sleep 2
done
[ -b "$data_device" ] || { echo "Polygraph data disk was not attached" >&2; exit 1; }

if ! blkid "$data_device" >/dev/null 2>&1; then mkfs.ext4 -F "$data_device"; fi
mkdir -p /data
data_uuid="$(blkid -s UUID -o value "$data_device")"
if ! grep -q "UUID=$data_uuid /data " /etc/fstab; then
  printf 'UUID=%s /data ext4 defaults,nofail 0 2\n' "$data_uuid" >> /etc/fstab
fi
mountpoint -q /data || mount /data
chown 1000:1000 /data

# The e2-small is deliberately cheap. One local source build needs a small,
# persistent swap file, while the old healthy container continues serving.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show=NAME | grep -qx /swapfile || swapon /swapfile

metadata_root="http://metadata.google.internal/computeMetadata/v1"
metadata_header="Metadata-Flavor: Google"
metadata() { curl -fsS -H "$metadata_header" "$metadata_root/$1"; }

project_id="$(metadata project/project-id)"
hostname="$(metadata instance/attributes/polygraph-hostname)"
source_repo="$(metadata instance/attributes/polygraph-source-repo)"
source_ref="$(metadata instance/attributes/polygraph-source-ref)"
token_json="$(metadata instance/service-accounts/default/token)"
access_token="$(printf '%s' "$token_json" | jq -r '.access_token')"

fetch_secret() {
  curl -fsS -H "Authorization: Bearer $access_token" \
    "https://secretmanager.googleapis.com/v1/projects/$project_id/secrets/$1/versions/latest:access" \
    | jq -r '.payload.data' | base64 -d
}

master_key="$(fetch_secret polygraph-master-key)"
brightdata_key="$(fetch_secret polygraph-brightdata-api-key)"
github_token="$(fetch_secret polygraph-demo-github-token)"

install -m 600 /dev/null /etc/polygraph.env
{
  printf 'NODE_ENV=production\n'
  printf 'PORT=8080\n'
  printf 'POLYGRAPH_DB=/data/polygraph.sqlite\n'
  printf 'POLYGRAPH_PUBLIC_ORIGIN=https://%s\n' "$hostname"
  printf 'POLYGRAPH_CONCURRENCY=4\n'
  printf 'POLYGRAPH_HEAL_ENABLED=1\n'
  printf 'POLYGRAPH_DEMO_LIVE=1\n'
  printf 'POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE=1\n'
  printf 'POLYGRAPH_DEMO_FIXTURE_REPO=Jayanthkoppala/polygraph-version-shift-store\n'
  printf 'POLYGRAPH_DEMO_FIXTURE_WORKFLOW=switch-version.yml\n'
  printf 'POLYGRAPH_DEMO_FIXTURE_URL=https://polygraph-version-shift-store.vercel.app\n'
  printf 'POLYGRAPH_DEMO_COLLECTOR_ID=c_mt3kif5w1ds27lttug\n'
  printf 'POLYGRAPH_DEMO_EXPECTED_PRODUCT_CODE=Product/Code-123\n'
  printf 'POLYGRAPH_DEMO_EXPECTED_PRICE=51.77\n'
  printf 'POLYGRAPH_DEMO_EXPECTED_CURRENCY=GBP\n'
  printf 'POLYGRAPH_DEMO_EXPECTED_SYMBOL=£\n'
  printf 'GOOGLE_CLOUD_PROJECT=%s\n' "$project_id"
  printf 'GOOGLE_CLOUD_LOCATION=global\n'
  printf 'POLYGRAPH_GEMINI_MODEL=gemini-3.1-flash-lite\n'
  printf 'POLYGRAPH_MASTER_KEY=%s\n' "$master_key"
  printf 'BRIGHTDATA_API_KEY=%s\n' "$brightdata_key"
  printf 'POLYGRAPH_DEMO_GITHUB_TOKEN=%s\n' "$github_token"
} > /etc/polygraph.env
unset master_key brightdata_key github_token token_json access_token

image="polygraph-source:${source_ref:0:12}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  source_dir="$(mktemp -d /tmp/polygraph-source.XXXXXX)"
  trap 'rm -r -- "$source_dir"' EXIT
  git clone --filter=blob:none "$source_repo" "$source_dir"
  git -C "$source_dir" fetch --depth=1 origin "$source_ref"
  git -C "$source_dir" checkout --detach FETCH_HEAD
  docker build --pull -t "$image" "$source_dir"
fi

previous_image="$(docker inspect --format '{{.Config.Image}}' polygraph 2>/dev/null || true)"
docker rm -f polygraph >/dev/null 2>&1 || true
docker run -d \
  --name polygraph \
  --restart unless-stopped \
  --network host \
  --env-file /etc/polygraph.env \
  -v /data:/data \
  "$image"

healthy=0
for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  docker logs --tail 160 polygraph || true
  docker rm -f polygraph >/dev/null 2>&1 || true
  if [ -n "$previous_image" ] && docker image inspect "$previous_image" >/dev/null 2>&1; then
    docker run -d --name polygraph --restart unless-stopped --network host --env-file /etc/polygraph.env -v /data:/data "$previous_image"
  fi
  exit 1
fi

mkdir -p /etc/polygraph /var/lib/polygraph-caddy /var/lib/polygraph-caddy-config
{
  printf '%s {\n' "$hostname"
  printf '  encode zstd gzip\n'
  printf '  reverse_proxy 127.0.0.1:8080\n'
  printf '}\n'
} > /etc/polygraph/Caddyfile

if ! docker inspect polygraph-caddy >/dev/null 2>&1; then
  docker run -d --name polygraph-caddy --restart unless-stopped --network host \
    -v /etc/polygraph/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v /var/lib/polygraph-caddy:/data \
    -v /var/lib/polygraph-caddy-config:/config caddy:2-alpine
else
  docker restart polygraph-caddy >/dev/null
fi

docker builder prune --force --filter until=24h >/dev/null 2>&1 || true
echo "Polygraph source ${source_ref} is healthy at https://${hostname}"
