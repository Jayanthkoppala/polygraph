#!/usr/bin/env bash
# Deploy a git ref to a Polygraph VM (polygraph-fifteenth-morning or
# polygraph-staging) by building a fresh image on the box from a git-archive
# tarball and swapping it in with a health-gated rollback.
#
# Usage: bash deploy/deploy.sh <vm> <git-ref>
#
# Requires ~/polygraph-runtime-<vm>.env to already exist on the target VM
# (0600, put there once via `bash deploy/remote.sh <vm> put <local-env> \
# ~/polygraph-runtime-<vm>.env` from a temp file — never commit it).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"

vm="${1:?usage: deploy.sh <vm> <git-ref>}"
ref="${2:?usage: deploy.sh <vm> <git-ref>}"

sha="$(git -C "$repo_root" rev-parse --short=7 "$ref")"
image="polygraph:${sha}"
release_dir="polygraph-releases/${sha}"
env_file="polygraph-runtime-${vm}.env"

echo "==> deploying ${ref} (${sha}) to ${vm}"

tarball="$(mktemp -t polygraph-${sha}.XXXXXX.tgz)"
trap 'rm -f "$tarball"' EXIT
git -C "$repo_root" archive --format=tar.gz -o "$tarball" "$ref"

echo "==> uploading source tarball"
bash "$here/remote.sh" "$vm" exec "mkdir -p ~/${release_dir}"
bash "$here/remote.sh" "$vm" put "$tarball" "~/${release_dir}.tgz"
bash "$here/remote.sh" "$vm" exec "tar -xzf ~/${release_dir}.tgz -C ~/${release_dir} && rm ~/${release_dir}.tgz"

echo "==> building ${image} on ${vm}"
bash "$here/remote.sh" "$vm" exec "docker build -t ${image} ~/${release_dir}"

echo "==> checking ~/${env_file} exists on ${vm}"
bash "$here/remote.sh" "$vm" exec "test -f ~/${env_file} || { echo 'missing ~/${env_file} — see deploy/README.md' >&2; exit 1; }"

echo "==> swapping container (previous kept as polygraph-pre-${sha} for rollback)"
bash "$here/remote.sh" "$vm" exec "
  set -euo pipefail
  prev_image=\"\$(docker inspect --format '{{.Config.Image}}' polygraph 2>/dev/null || true)\"
  prev_sha=\"\${prev_image#polygraph:}\"
  if docker inspect polygraph >/dev/null 2>&1; then
    docker rename polygraph \"polygraph-pre-${sha}\"
    docker stop \"polygraph-pre-${sha}\" >/dev/null
  fi
  docker run -d --name polygraph --restart unless-stopped --network host \
    --env-file ~/${env_file} -v /data:/data ${image}

  healthy=0
  for _ in \$(seq 1 60); do
    if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then healthy=1; break; fi
    sleep 2
  done
  if [ \"\$healthy\" -ne 1 ]; then
    echo 'new container failed healthcheck, rolling back' >&2
    docker logs --tail 160 polygraph || true
    docker rm -f polygraph >/dev/null 2>&1 || true
    if [ -n \"\$prev_sha\" ] && docker inspect \"polygraph-pre-${sha}\" >/dev/null 2>&1; then
      docker start \"polygraph-pre-${sha}\" >/dev/null
      docker rename \"polygraph-pre-${sha}\" polygraph
    fi
    exit 1
  fi
  echo \"polygraph:${sha} is healthy\"
"

echo "==> ${vm} is now running ${image}"
