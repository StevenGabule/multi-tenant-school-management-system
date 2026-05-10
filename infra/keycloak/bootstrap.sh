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
# ---------------------------------------------------------------------------
# In Keycloak 24+, the user-profile schema is enforced by default —
# arbitrary attributes are silently dropped unless declared OR unmanaged
# attributes are enabled. We do BOTH:
#   • Add tenant_id explicitly (with admin-only edit permission so users
#     can't change it from the account console).
#   • Set unmanagedAttributePolicy=ENABLED so future attributes don't
#     need a code change here.
# ---------------------------------------------------------------------------
ensure_user_profile() {
  local existing
  existing=$(kcadm get "realms/$REALM/users/profile" 2>/dev/null) || existing="{}"
  local updated
  updated=$(echo "$existing" | python3 -c "
import json, sys
p = json.load(sys.stdin)
if 'attributes' not in p:
    p['attributes'] = []
names = [a.get('name') for a in p['attributes']]
if 'tenant_id' not in names:
    p['attributes'].append({
        'name': 'tenant_id',
        'displayName': 'Tenant ID',
        'permissions': {'view': ['admin', 'user'], 'edit': ['admin']},
        'multivalued': False
    })
p['unmanagedAttributePolicy'] = 'ENABLED'
print(json.dumps(p))
")
  echo "$updated" | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
    update "realms/$REALM/users/profile" -f - >/dev/null
  echo "    user profile updated (tenant_id declared, unmanaged attrs enabled)"
}

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

echo "==> User profile schema"
ensure_user_profile

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

# Audience mapper: stamps `aud=gateway` on access tokens issued for the
# gateway client. Keycloak's default access-token audience is "account";
# our services validate against "gateway" (the API audience). Without
# this mapper, every guard would reject every token.
ensure_audience_mapper() {
  local client_uuid=$1
  local audience=$2
  local existing
  existing=$(kcadm get "clients/$client_uuid/protocol-mappers/models" -r "$REALM" \
    | python3 -c "import json,sys; arr=json.load(sys.stdin); ids=[m['id'] for m in arr if m.get('name')=='audience-$2']; print(ids[0] if ids else '')")
  if [ -n "$existing" ]; then
    echo "    audience mapper for $audience exists; skipping"
  else
    echo "    creating audience-$audience mapper on client $client_uuid"
    kcadm create "clients/$client_uuid/protocol-mappers/models" -r "$REALM" \
      -s "name=audience-$audience" \
      -s "protocol=openid-connect" \
      -s "protocolMapper=oidc-audience-mapper" \
      -s "config.\"included.client.audience\"=$audience" \
      -s 'config."access.token.claim"=true' \
      -s 'config."id.token.claim"=false'
  fi
}

ensure_audience_mapper "$GATEWAY_ID" gateway
ensure_audience_mapper "$SERVICES_ID" gateway

# ---------------------------------------------------------------------------
# Test user — used by mint-token.sh to fetch real JWTs in smoke tests.
# Password grant requires this user to exist; the tenant_id attribute is
# rewritten before each token request so tests can target arbitrary
# tenants (one-tenant-at-a-time).
# ---------------------------------------------------------------------------
echo "==> Test user: dev-tester"
EXISTING_USER=$(kcadm get users -r "$REALM" -q "username=dev-tester" --fields id 2>/dev/null \
  | python3 -c "import json,sys; arr=json.load(sys.stdin); print(arr[0]['id'] if arr else '')")
if [ -z "$EXISTING_USER" ]; then
  echo "    creating dev-tester"
  kcadm create users -r "$REALM" \
    -s "username=dev-tester" \
    -s "enabled=true" \
    -s "email=dev-tester@local.test" \
    -s "emailVerified=true"
  EXISTING_USER=$(kcadm get users -r "$REALM" -q "username=dev-tester" --fields id \
    | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
  kcadm set-password -r "$REALM" --userid "$EXISTING_USER" \
    --new-password "dev-pwd-for-tests" --temporary=false
else
  echo "    dev-tester exists ($EXISTING_USER); resetting password (non-temporary)"
  kcadm set-password -r "$REALM" --userid "$EXISTING_USER" \
    --new-password "dev-pwd-for-tests" --temporary=false
fi
# Some Keycloak versions still flag the user with UPDATE_PASSWORD even
# when --temporary=false. Strip required actions so password grant works.
kcadm update "users/$EXISTING_USER" -r "$REALM" -s 'requiredActions=[]'

# Assign all five roles to the test user so RBAC tests can choose which
# claim to assert against. Real users would have a subset; the dev
# tester is intentionally over-privileged.
for role in district-admin school-admin teacher parent student; do
  kcadm add-roles -r "$REALM" --uusername dev-tester --rolename "$role" 2>/dev/null || true
done

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
