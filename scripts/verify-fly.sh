#!/usr/bin/env bash
# Exercises a live Polygraph deploy the way a stranger would, and prints the
# HTTP status of every step. Called by deploy-fly.sh; also runnable alone:
#
#     ./scripts/verify-fly.sh https://polygraph.fly.dev
#
# This does not assume the deploy worked — it signs up a throwaway fleet,
# follows the one-time capability token through the exchange, and checks that
# the resulting session actually authenticates against a tenant-scoped route.

set -uo pipefail

BASE="${1:?usage: verify-fly.sh <base-url>}"
JAR="$(mktemp)"
FAIL=0

step() { printf '  %-34s %s\n' "$1" "$2"; }
check() { [ "$2" = "$3" ] || { echo "    EXPECTED $3, GOT $2"; FAIL=1; }; }

echo "Verifying ${BASE}"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/healthz")
step "GET /healthz" "$CODE"; check healthz "$CODE" 200

BODY=$(curl -sS -o /tmp/pg-index.html -w '%{http_code}' "${BASE}/")
step "GET /" "$BODY"; check index "$BODY" 200
if grep -qE '<div id="root"|/assets/index-.*\.js' /tmp/pg-index.html; then
  step "  SPA shell present" "yes"
else
  step "  SPA shell present" "NO"; FAIL=1
fi

# Signup is the real path: it mints the one-time capability token that is the
# only credential the product ever issues.
SIGNUP=$(curl -sS -o /tmp/pg-signup.json -w '%{http_code}' \
  -X POST "${BASE}/api/signup" \
  -H 'content-type: application/json' \
  -H "origin: ${BASE}" \
  -d '{"fleet_name":"deploy smoke test"}')
step "POST /api/signup" "$SIGNUP"; check signup "$SIGNUP" 200

TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' /tmp/pg-signup.json)
if [ -z "$TOKEN" ]; then
  echo "    no token in signup response: $(cat /tmp/pg-signup.json)"; FAIL=1
else
  step "  token issued" "yes (not printed)"

  EXCH=$(curl -sS -o /dev/null -w '%{http_code}' -c "$JAR" "${BASE}/t/${TOKEN}")
  step "GET /t/:token" "$EXCH"; check exchange "$EXCH" 302

  STATE=$(curl -sS -o /tmp/pg-state.json -w '%{http_code}' -b "$JAR" "${BASE}/api/state")
  step "GET /api/state (with session)" "$STATE"; check state "$STATE" 200
fi

# The same route with no cookie must NOT be readable — if this returns 200 the
# tenant isolation that the whole product rests on is broken in production.
NOAUTH=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/state")
step "GET /api/state (no session)" "$NOAUTH"
[ "$NOAUTH" = "200" ] && { echo "    FATAL: tenant state readable without a session"; FAIL=1; }

# The public showcase is meant to be readable with no signup at all. A 404 is
# an acceptable result: nothing auto-seeds a showcase tenant, so until an
# operator runs `polygraph admin set-public <id> on` there is honestly nothing
# to show, and fabricating one would be worse than an empty state.
SHOW=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/showcase/state")
step "GET /api/showcase/state" "$SHOW"
case "$SHOW" in
  200) step "  showcase configured" "yes" ;;
  404) step "  showcase configured" "no — run 'polygraph admin set-public <tenant-id> on'" ;;
  *)   echo "    unexpected showcase status"; FAIL=1 ;;
esac

rm -f "$JAR"
echo
if [ "$FAIL" = "0" ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit "$FAIL"
