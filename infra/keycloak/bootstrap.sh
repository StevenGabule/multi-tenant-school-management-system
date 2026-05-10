#!/bin/bash
# =============================================================================
# Keycloak realm bootstrap (idempotent).
#
# Configures the sms-platform realm with the role/group/client model from
# milestone 1.6. Re-runnable: every operation either skips if the object
# exists or updates it in place.
#
# Run from the host:
#   ./infra/keycloak/bootstrap.sh
# Or from inside the container if you've docker-exec'd in:
#   /opt/keycloak/bin/kcadm.sh ... (this script wraps that)
#
# Why bash + kcadm.sh (not Terraform): the project doesn't have a TF
# pipeline yet; introducing one for ONE resource type is overkill.
# Phase 2 may move to terraform-keycloak-provider when realms multiply.
# =============================================================================

set -euo pipefail

KC_CONTAINER=${KC_CONTAINER:-sms-keycloak}
KC_URL=${KC_URL:-http://localhost:8080}
KC_ADMIN=${KC_ADMIN:-admin}
KC_ADMIN_PASS=${KC_ADMIN_PASS:-admin_local_dev_pwd}
REALM=${REALM:-sms-platform}

# Run kcadm.sh inside the container — that's where the binary lives.
kcadm() {
  docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"
}

echo "==> Authenticating to Keycloak as $KC_ADMIN"
kcadm config credentials \
  --server "$KC_URL" \
  --realm master \
  --user "$KC_ADMIN" \
  --password "$KC_ADMIN_PASS"

# ---------------------------------------------------------------------------
# Realm
# ---------------------------------------------------------------------------
echo "==> Realm: $REALM"
if kcadm get "realms/$REALM" >/dev/null 2>&1; then
  echo "    (exists; updating)"
  kcadm update "realms/$REALM" \
    -s "enabled=true" \
    -s "accessTokenLifespan=900" \
    -s "ssoSessionIdleTimeout=1800" \
    -s "ssoSessionMaxLifespan=36000" \
    -s "revokeRefreshToken=true" \
    -s "refreshTokenMaxReuse=0"
else
  kcadm create realms \
    -s "realm=$REALM" \
    -s "enabled=true" \
    -s "accessTokenLifespan=900" \
    -s "ssoSessionIdleTimeout=1800" \
    -s "ssoSessionMaxLifespan=36000" \
    -s "revokeRefreshToken=true" \
    -s "refreshTokenMaxReuse=0"
fi

# ---------------------------------------------------------------------------
# Realm roles
# ---------------------------------------------------------------------------
ensure_role() {
  local role=$1
  if kcadm get "roles/$role" -r "$REALM" >/dev/null 2>&1; then
    echo "    role $role exists"
  else
    echo "    creating role $role"
    kcadm create roles -r "$REALM" -s "name=$role"
  fi
}

echo "==> Realm roles"
ensure_role district-admin
ensure_role school-admin
ensure_role teacher
ensure_role parent
ensure_role student

# ---------------------------------------------------------------------------
# Clients
#
# `gateway`  — public client (no secret). Used by SPA / curl / tests.
#              Direct access grants enabled in dev so we can fetch tokens
#              via username/password (replaces the hand-rolled
#              /api/dev/token endpoint).
# `services` — confidential client. Service-to-service via the
#              client_credentials grant.
# ---------------------------------------------------------------------------
ensure_client() {
  local client_id=$1; shift
  local existing
  existing=$(kcadm get clients -r "$REALM" -q "clientId=$client_id" --fields id 2>/dev/null \
    | python3 -c "import json,sys; arr=json.load(sys.stdin); print(arr[0]['id'] if arr else '')")
  if [ -n "$existing" ]; then
    echo "    client $client_id exists ($existing); updating"
    kcadm update "clients/$existing" -r "$REALM" "$@"
    echo "$existing"
  else
    echo "    creating client $client_id"
    kcadm create clients -r "$REALM" -s "clientId=$client_id" "$@"
    kcadm get clients -r "$REALM" -q "clientId=$client_id" --fields id 2>/dev/null \
      | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])"
  fi
}

echo "==> Client: gateway (public)"
GATEWAY_ID=$(ensure_client gateway \
  -s "publicClient=true" \
  -s "directAccessGrantsEnabled=true" \
  -s "standardFlowEnabled=true" \
  -s "implicitFlowEnabled=false" \
  -s "serviceAccountsEnabled=false" \
  -s 'redirectUris=["http://localhost:3000/*"]' \
  -s 'webOrigins=["http://localhost:3000"]' \
  -s "attributes.\"pkce.code.challenge.method\"=S256" \
  | tail -n1)
echo "    gateway uuid: $GATEWAY_ID"

echo "==> Client: services (confidential)"
SERVICES_ID=$(ensure_client services \
  -s "publicClient=false" \
  -s "directAccessGrantsEnabled=false" \
  -s "standardFlowEnabled=false" \
  -s "serviceAccountsEnabled=true" \
  -s 'redirectUris=[]' \
  -s 'webOrigins=[]' \
  | tail -n1)
echo "    services uuid: $SERVICES_ID"

# Show the services client secret so .env.local can capture it.
SERVICES_SECRET=$(kcadm get "clients/$SERVICES_ID/client-secret" -r "$REALM" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['value'])")
echo "    services client secret: $SERVICES_SECRET"

# ---------------------------------------------------------------------------
# tenant_id protocol mapper on the gateway client.
#
# Maps each user's `tenant_id` attribute to a `tenant_id` claim in the
# access token. Users get the attribute via `kcadm update users/<id> -s
# 'attributes.tenant_id=["<uuid>"]'` (or via the admin console).
#
# Why a user-attribute mapper (not group membership): simpler. Group-
# extraction-via-script-mapper is the more elegant pattern but harder to
# automate cleanly here. Phase 1 lives with one-tenant-per-user;
# multi-tenancy-per-user is a known limit (documented in ADR-0014).
# ---------------------------------------------------------------------------
ensure_tenant_id_mapper() {
  local client_uuid=$1
  local existing
  existing=$(kcadm get "clients/$client_uuid/protocol-mappers/models" -r "$REALM" \
    | python3 -c "import json,sys; arr=json.load(sys.stdin); ids=[m['id'] for m in arr if m.get('name')=='tenant_id']; print(ids[0] if ids else '')")
  if [ -n "$existing" ]; then
    echo "    tenant_id mapper exists on client; skipping"
  else
    echo "    creating tenant_id mapper on client $client_uuid"
    # kcadm doesn't read stdin via -f-; pass each setting as -s flags.
    kcadm create "clients/$client_uuid/protocol-mappers/models" -r "$REALM" \
      -s "name=tenant_id" \
      -s "protocol=openid-connect" \
      -s "protocolMapper=oidc-usermodel-attribute-mapper" \
      -s 'config."user.attribute"=tenant_id' \
      -s 'config."claim.name"=tenant_id' \
      -s 'config."jsonType.label"=String' \
      -s 'config."id.token.claim"=true' \
      -s 'config."access.token.claim"=true' \
      -s 'config."userinfo.token.claim"=true'
  fi
}

ensure_tenant_id_mapper "$GATEWAY_ID"
ensure_tenant_id_mapper "$SERVICES_ID"

echo
echo "==> Done."
echo
echo "Next steps:"
echo "  1. Capture the services client secret in .env.local:"
echo "     KEYCLOAK_SERVICES_CLIENT_SECRET=$SERVICES_SECRET"
echo "  2. Create test users via kcadm or the admin console at"
echo "     http://localhost:8080/admin/ (admin / admin_local_dev_pwd)."
echo "  3. The OIDC discovery URL is:"
echo "     $KC_URL/realms/$REALM/.well-known/openid-configuration"
