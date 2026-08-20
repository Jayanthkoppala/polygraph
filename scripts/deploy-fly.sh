#!/usr/bin/env bash
# One-command Fly deploy for the hosted Polygraph product.
#
# Everything except the interactive `fly auth login` is automated here. Run:
#
#     fly auth login          # opens a browser; only a human can do this
#     ./scripts/deploy-fly.sh # everything else
#
# Optionally pass an app name if `polygraph` is already taken on Fly (app
# names are a single global namespace, so it very likely is):
#
#     ./scripts/deploy-fly.sh my-polygraph
#
# The app name is not cosmetic. POLYGRAPH_PUBLIC_ORIGIN is what the CSRF gate
# compares the Origin header against (src/tenancy/http-routes.ts), so it has to
# match the hostname the browser actually talks to or every mutating route —
# the whole onboarding wizard, saving a Bright Data key — starts rejecting
# real requests. This script keeps fly.toml's `app` and its
# POLYGRAPH_PUBLIC_ORIGIN in lockstep for exactly that reason.

set -euo pipefail

cd "$(dirname "$0")/.."

APP="${1:-polygraph}"
REGION="${FLY_REGION:-iad}"
VOLUME="polygraph_data"
ORIGIN="https://${APP}.fly.dev"

if ! command -v fly >/dev/null 2>&1; then
  export PATH="$HOME/.fly/bin:$PATH"
fi
command -v fly >/dev/null 2>&1 || {
  echo "fly CLI not found. Install it with: curl -L https://fly.io/install.sh | sh" >&2
  exit 1
}

fly auth whoami >/dev/null 2>&1 || {
  echo "Not logged in to Fly. Run 'fly auth login' first, then re-run this script." >&2
  exit 1
}

echo "==> Deploying as '${APP}' in ${REGION} (origin ${ORIGIN})"

# Keep fly.toml consistent with the app name actually being deployed.
if [ "${APP}" != "polygraph" ]; then
  sed -i '' -e "s|^app = \".*\"|app = \"${APP}\"|" \
            -e "s|^  POLYGRAPH_PUBLIC_ORIGIN = \".*\"|  POLYGRAPH_PUBLIC_ORIGIN = \"${ORIGIN}\"|" fly.toml
fi

# The SPA is built inside the image too, but building it here first fails fast
# on a frontend error instead of halfway through a remote Docker build.
echo "==> Building frontend"
(cd app && npm ci --silent && npm run build)

echo "==> Creating the app (ignored if it already exists)"
fly apps create "${APP}" 2>/dev/null || echo "    app already exists, continuing"

# The master key encrypts every tenant's Bright Data credential. It is
# generated with real entropy, set as a Fly SECRET, and never written to
# fly.toml, the repo, or this terminal's scrollback. Losing it means every
# stored tenant secret is unrecoverable, so it is generated exactly once and
# only if the app does not already have one.
if fly secrets list -a "${APP}" 2>/dev/null | grep -q POLYGRAPH_MASTER_KEY; then
  echo "==> POLYGRAPH_MASTER_KEY already set; leaving it alone"
  echo "    (rotating it would orphan every tenant secret already encrypted under it)"
else
  echo "==> Generating and setting POLYGRAPH_MASTER_KEY (32 bytes, base64)"
  fly secrets set POLYGRAPH_MASTER_KEY="$(openssl rand -base64 32)" -a "${APP}" --stage
  echo "    set (value not printed)"
fi

echo "==> Creating the SQLite volume"
if fly volumes list -a "${APP}" 2>/dev/null | grep -q "${VOLUME}"; then
  echo "    volume already exists, continuing"
else
  fly volumes create "${VOLUME}" -a "${APP}" -r "${REGION}" -n 1 -s 1 --yes
fi

echo "==> Deploying"
# --remote-only builds the image on Fly's own builder machine. That is also
# what makes this work on a machine whose local Docker daemon is unhealthy,
# and it guarantees a linux/amd64 image from an arm64 Mac.
fly deploy -a "${APP}" --ha=false --remote-only

# R6: hosted heal is structurally impossible because a heal spends the
# TENANT's Bright Data credits, not ours. The gate is the absence of this env
# var, so assert the absence rather than trusting it.
echo "==> Verifying POLYGRAPH_HEAL_ENABLED is absent"
if fly secrets list -a "${APP}" | grep -q POLYGRAPH_HEAL_ENABLED; then
  echo "FATAL: POLYGRAPH_HEAL_ENABLED is set as a secret. Unset it: fly secrets unset POLYGRAPH_HEAL_ENABLED -a ${APP}" >&2
  exit 1
fi
grep -q POLYGRAPH_HEAL_ENABLED fly.toml && \
  grep POLYGRAPH_HEAL_ENABLED fly.toml | grep -qv '^\s*#' && {
    echo "FATAL: POLYGRAPH_HEAL_ENABLED is set in fly.toml." >&2; exit 1; }
echo "    absent, as required"

echo "==> Smoke-testing the live deploy"
./scripts/verify-fly.sh "${ORIGIN}"

echo
echo "LIVE: ${ORIGIN}"
