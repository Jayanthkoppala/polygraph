#!/bin/bash
set -Eeuo pipefail

exec > >(tee -a /var/log/polygraph-startup.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl docker.io git jq
systemctl enable --now docker
usermod -aG docker jay || true

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

if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  swapoff /swapfile 2>/dev/null || true
  rm -f /swapfile
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi

metadata_root="http://metadata.google.internal/computeMetadata/v1"
metadata_header="Metadata-Flavor: Google"
metadata() { curl -fsS -H "$metadata_header" "$metadata_root/$1"; }
hostname="$(metadata instance/attributes/polygraph-hostname)"

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

echo "Polygraph staging box ready at https://${hostname} (app container deployed separately via deploy/deploy.sh)"
