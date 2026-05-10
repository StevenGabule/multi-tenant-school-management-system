#!/bin/bash
# =============================================================================
# Mint a real Keycloak JWT for testing.
#
# Replaces the milestone 1.1–1.5 hand-rolled /api/dev/token endpoint.
# Sets the dev-tester user's tenant_id attribute to whatever was passed,
# then runs the OIDC password grant to fetch a real access_token.
#
# Usage:
#   ./infra/keycloak/mint-token.sh --tenant <uuid>          # all roles
#   ./infra/keycloak/mint-token.sh --tenant <uuid> --role parent
#
# CAUTION: rewrites dev-tester's tenant_id attribute on every call —
# parallel tests for different tenants will race. Sequential test flows
# only.
# =============================================================================

set -euo pipefail

KC_CONTAINER=${KC_CONTAINER:-sms-keycloak}
KC_URL=${KC_URL:-http://localhost:8080}
KC_ADMIN=${KC_ADMIN:-admin}
KC_ADMIN_PASS=${KC_ADMIN_PASS:-admin_local_dev_pwd}
REALM=${REALM:-sms-platform}
USERNAME=${USERNAME:-dev-tester}
PASSWORD=${PASSWORD:-dev-pwd-for-tests}

TENANT=""
ROLE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --role)   ROLE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TENANT" ]; then
  echo "usage: $0 --tenant <uuid> [--role <role>]" >&2
  exit 2
fi

kcadm() {
  docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@" 2>/dev/null
}

# Re-auth admin (idempotent; no harm in re-running each call)
kcadm config credentials \
  --server "$KC_URL" \
  --realm master \
  --user "$KC_ADMIN" \
  --password "$KC_ADMIN_PASS" >/dev/null

# Find user, set tenant_id attribute
USER_ID=$(kcadm get users -r "$REALM" -q "username=$USERNAME" --fields id \
  | python3 -c "import json,sys; arr=json.load(sys.stdin); print(arr[0]['id'] if arr else '')")
if [ -z "$USER_ID" ]; then
  echo "user $USERNAME not found in realm $REALM (run bootstrap.sh first)" >&2
  exit 1
fi

kcadm update "users/$USER_ID" -r "$REALM" \
  -s "attributes.tenant_id=[\"$TENANT\"]" >/dev/null

# Password grant against the gateway client
RESPONSE=$(curl -sS -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "client_id=gateway" \
  -d "grant_type=password" \
  -d "username=$USERNAME" \
  -d "password=$PASSWORD" \
  -d "scope=openid")

TOKEN=$(echo "$RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'access_token' not in d:
    print('Token request failed:', json.dumps(d), file=sys.stderr)
    sys.exit(1)
print(d['access_token'])
")

# If --role was passed, optionally narrow: today the dev-tester has all
# roles, so the role flag is informational. (A future refactor could
# create per-role users.)
echo "$TOKEN"
