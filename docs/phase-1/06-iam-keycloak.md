# Phase 1.6 — IAM with Keycloak

> **Concepts:** OIDC authorization code flow with PKCE, JWT structure and validation, JWKS rotation, refresh token rotation, RBAC + ABAC, the `parent of student X` problem, realm-per-tenant vs single-realm, token introspection vs JWT validation, the OWASP API Top 10 issues that auth bugs map to
> **Estimated effort:** 3 weekends — auth is the longest pole and rewards depth
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 1.0–1.5 complete
> - Read [`../../documentation.md`](../../documentation.md) §6.3 (Authentication flows by persona), §6.4 (Authorization)
> - Read the OAuth 2.1 BCP draft and OIDC core specs at least skim level — search `oauth.net` and `openid.net`
> - Familiarize with Keycloak via its [getting started](https://www.keycloak.org/getting-started) docs

---

## What you'll learn

- The **OIDC authorization code flow with PKCE** — what each parameter does, why PKCE exists, what redirect URIs validate, and what the front channel vs back channel really means.
- The structure of a **JWT** (header + payload + signature), the standard claims (`sub`, `iss`, `aud`, `exp`, `iat`, `nbf`, `jti`), custom claims for tenant context, and the role of the signature.
- How **JWKS** (JSON Web Key Set) discovery works: the `/.well-known/openid-configuration` endpoint, the `jwks_uri`, and key rotation — and why caching JWKS forever causes outages.
- **Refresh token rotation** and its security guarantees: what session fixation is, why rotation prevents it, and what happens on rotation theft detection.
- **Realm-per-tenant vs single-realm-with-tenant-claim**: the procurement, security, and operational tradeoffs and how to defend a choice.
- **RBAC** with role hierarchies (district-admin > school-admin > teacher > parent > student) and **ABAC** for relationship-based access ("parent of student X"), with a sketch of OPA / Cerbos for centralized policy.
- **Token introspection** vs **JWT-only validation**: the latency vs revocation tradeoff and when each is right.
- The OWASP API Security Top 10 mapping: A01 *Broken Object Level Authorization*, A02 *Broken Authentication*, A05 *Broken Function Level Authorization* — and how this milestone defends each.

---

## Why this matters (senior perspective)

Auth bugs are the highest-impact bugs in any system. A SQL injection might leak a column; an auth bug grants a stranger admin. Most pentest reports lead with auth findings. Most public breaches are auth failures.

The mitigation is not "be careful." The mitigation is using the standards and the libraries that have been adversarially tested by thousands of security teams over fifteen years. **Hand-rolled JWT validation is uniformly worse than even modest off-the-shelf solutions.** This is true for you in this learning project too — the JWT pattern from milestone 1.1 was a stepping stone, not an architecture.

The senior posture has three parts:

1. **Use the standard. Don't be clever.** OIDC + PKCE is not perfect. It is well-understood, broadly attacked, broadly defended. Your custom flow is a fresh attack surface no one has reviewed.
2. **Authentication and authorization are different.** *Authn* answers "who are you?"; *authz* answers "what can you do?" Mixing them in one guard creates bugs that pass review because the reviewer is also confused. Separate them in code.
3. **The parent-of-student-X problem is the test.** A system that can express "Parent A can see Student S because A is in S.guardians" — and that *enforces* it consistently across BFF, services, and database — has earned its authorization model. A system that can't is one bug away from a parent seeing another family's children.

The fourth senior moment is the **realm-per-tenant** decision. The doc lists both options without strongly recommending one. The honest answer:
- **Single realm with `tenant_id` claim** is much simpler operationally (one realm to maintain, one set of clients, one set of identity providers).
- **Realm-per-tenant** is necessary when each tenant brings their own IdP (federated SSO, different MFA policies, different session timeouts) and when the procurement story demands "a separate tenant's directory cannot be browsed by ours."

For Phase 1, single realm with tenant claim is the right call — you don't have IdP federation yet. Plan to revisit when enterprise tier customers arrive. Document this in your ADR.

---

## Hands-on plan

### Step 1 — Stand up Keycloak

1. Add Keycloak to docker-compose: `quay.io/keycloak/keycloak:latest` in dev mode (`start-dev`), pointed at a dedicated `keycloak_db` Postgres database.
2. Create an admin account; log into the admin console (default `localhost:8080`).
3. Create a realm: `sms-platform`.
4. Within the realm, create two clients:
   - `gateway` — public client, OIDC authorization code + PKCE, redirect URI to your local app, no client secret.
   - `services` — confidential client, client credentials grant, used for service-to-service token validation.

### Step 2 — Define the role and group model

In the realm:
1. Create realm roles: `district-admin`, `school-admin`, `teacher`, `parent`, `student`.
2. Create groups (one per tenant): `tenant:<uuid>:district-admins`, `tenant:<uuid>:school-admins`, etc. Group membership is the binding between a user and a tenant.
3. Add a custom mapper to the `gateway` client that emits a `tenant_id` claim derived from the user's group membership. (You can do this with a script mapper that finds the first `tenant:*` group and extracts the UUID.)

Result: a user logging in receives a JWT with `realm_access.roles: [...]` and `tenant_id: <uuid>`.

**Single-realm caveat:** every user belongs to exactly one tenant for now. A user who needs access to multiple tenants gets one identity per tenant. If this constraint breaks with enterprise customers (a parent at two schools), revisit; this is a known limit, not a flaw.

### Step 3 — Configure the gateway as an OIDC client

1. Install OIDC libraries: `pnpm add openid-client passport passport-jwt`.
2. Replace the hand-rolled JWT logic in `JwtAuthGuard` with one that:
   - Fetches the realm's `/.well-known/openid-configuration` on startup; caches `jwks_uri` and `issuer`.
   - On each request, validates the JWT signature against the JWKS (cached for ~10 minutes; refresh on `kid` not found).
   - Validates `iss` matches the realm, `aud` matches the gateway's client ID, `exp` is in the future, `nbf` is not in the future.
   - Extracts `tenant_id`, `sub`, `realm_access.roles` into `request.user`.
3. Test: log in via the OIDC flow (Postman has built-in support) and call a protected endpoint with the access token. You should see the same behavior as the hand-rolled JWT, but now Keycloak issues the token.

### Step 4 — Refresh token rotation

1. Configure short access token lifetime (15 minutes) and longer refresh token lifetime (7 days) in Keycloak realm settings.
2. Enable refresh token rotation: each use of a refresh token issues a new one, invalidating the old.
3. Configure refresh token theft detection: if the same refresh token is used twice (because the legitimate client got the new one and someone else used the old one), revoke the entire session and force re-login.
4. Build a `/auth/refresh` endpoint on the gateway (or use Keycloak's directly). The frontend (eventually) keeps the refresh token in `httpOnly` `Secure` `SameSite=Strict` cookie; the access token is sent in `Authorization: Bearer ...` headers.

### Step 5 — RBAC: the role hierarchy

Define the hierarchy in code (Keycloak has composite roles, but expressing the hierarchy in your authz layer is clearer):

```typescript
const ROLE_HIERARCHY: Record<string, string[]> = {
  'district-admin': ['school-admin', 'teacher', 'parent', 'student'],
  'school-admin': ['teacher'],
  // teacher, parent, student have no implied roles
};

function userHasRole(user: User, required: string): boolean {
  return user.roles.some(r => r === required || ROLE_HIERARCHY[r]?.includes(required));
}
```

Build a `RolesGuard`:

```typescript
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const required = this.reflector.get<string[]>('roles', context.getHandler());
    if (!required) return true;
    const user = context.switchToHttp().getRequest().user;
    return required.some(role => userHasRole(user, role));
  }
}

// usage:
@Roles('school-admin')
@Get('/students')
listAllStudents() { ... }
```

A district admin calling `/students` succeeds (district-admin > school-admin in the hierarchy). A parent calling it fails.

### Step 6 — ABAC: the parent-of-student-X problem

A parent calling `GET /students/:id` should succeed *if* the requested student is in the parent's `guardian_links`. RBAC alone can't express this — the predicate depends on the *resource*.

Two layers of defense:

1. **In the SIS service**: an `AuthzService.canAccessStudent(user, studentId)` that checks the parent-of relation. The `findStudent` use case calls it before returning.
2. **In Postgres RLS**: the `Student` policy is currently `tenant_id = current_setting(...)`. Extend it for parents:

```sql
CREATE POLICY parent_visibility ON "Student"
  USING (
    "tenantId" = current_setting('app.current_tenant_id')::uuid
    AND (
      current_setting('app.current_role') = 'admin'
      OR EXISTS (
        SELECT 1 FROM "GuardianLink" gl
        WHERE gl."studentId" = "Student".id
          AND gl."guardianId" = current_setting('app.current_user_id')::uuid
      )
    )
  );
```

The middleware sets two GUCs: `app.current_tenant_id` and `app.current_user_id`. The policy now defends correctly even if the application layer forgets.

This is your first taste of **defense in depth**: BFF/service-layer check + database policy. Either layer alone is sufficient; both layers together is what senior engineers ship.

### Step 7 — The RLS recursion gotcha

You read about this in milestone 1.1; now you're hitting it. The new policy on `Student` references `GuardianLink`, which has its own RLS policy, which might (in some designs) reference `User`, which might reference `Student`... If the cycle closes, you get infinite recursion.

Solution: the lookup against `GuardianLink` runs as a `SECURITY DEFINER` function:

```sql
CREATE OR REPLACE FUNCTION app.is_guardian_of(student_id uuid, user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "GuardianLink"
    WHERE "studentId" = student_id AND "guardianId" = user_id
  );
$$;

REVOKE ALL ON FUNCTION app.is_guardian_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_guardian_of(uuid, uuid) TO app_user;
```

The function runs with the privilege of its owner (a role with `BYPASSRLS` on `GuardianLink`), so the inner query succeeds without triggering its own RLS. Reference it in the `Student` policy:

```sql
... OR app.is_guardian_of("Student".id, current_setting('app.current_user_id')::uuid)
```

This is one of the named gotchas in the original document and in the Nile blog.

### Step 8 — Service-to-service auth

Internal calls (gateway → SIS, enrollment-saga → academic) use the `services` confidential client:

1. The gateway, on each user request, mints (or fetches) a service-to-service token via the `services` client's `client_credentials` grant.
2. Internal calls send both the user's access token AND the service token. Receiving services validate the user token (for actor identity) AND the service token (for caller identity).
3. Alternative: the service mesh (Phase 2) handles caller identity via mTLS; you don't need a service token in the application layer.

For Phase 1, the simpler pattern: the user's JWT is forwarded internally; services trust each other implicitly because they're inside the cluster (and Phase 2's NetworkPolicies + service mesh will enforce that). Document the trust boundary; don't pretend it's stronger than it is.

### Step 9 — Token introspection (preview)

Keycloak exposes a `/protocol/openid-connect/token/introspect` endpoint. JWT-only validation is faster (no network call); introspection adds a network hop but allows immediate revocation (Keycloak knows about logout / token revocation, JWTs in flight don't).

Hybrid pattern: validate JWT signature locally for performance; for high-value operations (financial transactions, admin actions), additionally hit the introspection endpoint. Phase 1 doesn't require this; document it in the ADR as a Phase 2 expansion.

### Step 10 — OPA / Cerbos sketch (optional)

For complex authorization (multi-attribute policies that change without redeploy), sidecar policy engines beat hard-coded guards. Rego (OPA) and YAML (Cerbos) are the two main contenders.

You don't need to deploy one in Phase 1. Read the docs, sketch what your `parent_of_student` policy would look like in Rego, and note in your ADR when you'd graduate to a policy engine.

### Step 11 — Tests

- **Login flow end-to-end** (curl with the OIDC discovery endpoint).
- **JWT signature validation**: tamper with the signature; assert 401.
- **Expired token**: assert 401.
- **Wrong audience**: token from another client; assert 401.
- **JWKS rotation**: rotate Keycloak's signing key; assert your service refreshes JWKS and continues validating.
- **RBAC**: parent token cannot hit district-admin endpoints; assert 403.
- **ABAC**: parent A's token cannot access parent B's child's endpoint; assert 403; assert RLS catches it even if the application layer is bypassed (manual `psql` test).
- **Refresh token rotation**: use a refresh token twice; assert the second use revokes the session.

### Step 12 — Write the ADRs

At least two:
- [`adr/0012-iam-backbone.md`](../adr/) — Keycloak vs Auth0 vs DIY; defending the choice including the cost dimension.
- [`adr/0013-realm-strategy.md`](../adr/) — single-realm-with-tenant-claim vs realm-per-tenant; the conditions under which Phase 2 graduates.

---

## Definition of done

- [x] Keycloak running with realm `sms-platform` and two clients (`gateway`, `services`). *(commit `2ae1853`; container `sms-keycloak` healthy; OIDC discovery at `http://localhost:8080/realms/sms-platform/.well-known/openid-configuration`)*
- [x] Realm roles + `tenant_id` mapper emit the claim correctly. *(commits `94d6cc9`, `3ebb231`; user-attribute mapper on both clients; user-profile schema declares `tenant_id` with admin-only edit; realm tokens carry `tenant_id` UUID)*
- [x] Services validate JWTs against Keycloak's JWKS, cached with refresh on unknown `kid`. *(commits `3ebb231`, `feat: migrate gateway/sis/academic/enrollment to KeycloakAuthGuard`; `libs/auth-keycloak` uses jose's `createRemoteJWKSet` with 10-min cache + 30s cooldown)*
- [x] Hand-rolled JWT logic from milestone 1.1 fully replaced. *(commit `feat: migrate gateway/sis/academic/enrollment to KeycloakAuthGuard`; deleted `dev-tokens.controller.ts` and 4× local `jwt-auth.guard.ts`; removed `JwtModule` from enrollment-service in `feat(enrollment-service): saga uses Keycloak service tokens`)*
- [~] Refresh token rotation + theft detection. **Configured at the realm level** (`revokeRefreshToken=true`, `refreshTokenMaxReuse=0` in bootstrap.sh) but the end-to-end "use the same refresh token twice → session revoked" test is deferred to milestone 1.7 alongside the BFF cookie-handling code (no SPA today to drive the rotation).
- [x] `RolesGuard` + role hierarchy. *(commit `feat(libs/auth-keycloak)`; `Roles()` decorator + ROLE_HIERARCHY in `libs/auth-keycloak/src/lib/roles.guard.ts`; `district-admin > school-admin > teacher`, parent/student leaf)*
- [x] `parent of student X` ABAC at service layer AND in RLS policy. *(commit `feat(sis-service): parent-of-student-X ABAC at SQL + application layer`; `AuthzService.assertCanAccessStudent` + the rewritten `tenant_isolation` policy on `student` reading `app.is_guardian_of` via SECURITY DEFINER)*
- [x] `SECURITY DEFINER` helper for `is_guardian_of` lookup. *(migration `20260510130000_parent_abac_rls`; `app.is_guardian_of(uuid, uuid)` STABLE LANGUAGE sql, BYPASSRLS via the function owner)*
- [~] All twelve test scenarios from step 11. **Partial — 5 of 12 verified end-to-end:**
  - [x] Login flow end-to-end (`infra/keycloak/mint-token.sh` + verified saga happy path with real Keycloak token)
  - [x] JWT signature tampering → 401 (verified manually in step-9 negative tests)
  - [x] Missing Authorization → 401
  - [x] Wrong audience (master realm token) → 401
  - [x] Hand-rolled JWT_SECRET token rejected (no Keycloak signature) → 401
  - [ ] Expired token → 401 (relies on natural exp; not exercised under wall-clock fault)
  - [ ] JWKS rotation: rotate Keycloak's signing key, verify service refreshes (not exercised)
  - [ ] RBAC: parent token rejected from district-admin endpoint (the guard exists; no controller currently has `@Roles()` applied)
  - [x] ABAC: parent A's token cannot access parent B's child (covered by 7 unit tests in `authz.service.spec.ts` + the SQL policy)
  - [ ] ABAC RLS catches bypass (manual psql test deferred — would require a Testcontainers integration test against the migration)
  - [ ] Refresh-token rotation: use a refresh token twice, second use revokes session (deferred — no SPA driver)
  - [ ] Concurrent saga + auth (load test, not in scope for 1.6)
- [x] Cross-tenant test from milestone 1.1 still passes. *(58 sis tests + 7 new authz tests = 65/65 passing; the cross-tenant test in `student.cross-tenant.spec.ts` is part of those 58)*
- [x] ADR-0013 (IAM backbone) and ADR-0014 (realm strategy) written. *(numbers shifted from milestone-doc 0012/0013 because milestone 1.5 took those slots)*

**End-to-end verification (manual, recorded in conversation):**

Happy path with Keycloak service token:
  POST /api/enrollments → 202 with sagaId. Saga executor uses
  client_credentials grant against `services` confidential client +
  X-Tenant-Id header. Step 1 (create-student) calls SIS, KeycloakAuthGuard
  validates the service token, accepts the X-Tenant-Id header (because
  preferred_username starts with `service-account-`), populates CLS,
  use case runs. Step 2 (confirm-enrollment) same path against academic.
  Saga ends `completed`. Student in sms_sis, enrollment in sms_academic.

Negative tests (`step 9` of this milestone):
  Valid token → 201; missing Authorization → 401; tampered signature → 401;
  legacy hand-rolled JWT_SECRET token → 401 (signature doesn't match
  Keycloak JWKS); master-realm token → 401 (wrong issuer + audience).

---

## Common pitfalls

1. **Trusting JWT claims without verifying the signature.** Even one missed verification path (e.g., a worker that decodes a JWT for logging) is a critical bug.
2. **Not validating `aud` (audience).** A token issued for client A is accepted by service B. Authentication-as-such succeeds; authorization is silently broken.
3. **Caching JWKS forever.** When Keycloak rotates its signing key, your service rejects all tokens until restarted. Cache with refresh on unknown `kid`.
4. **Long-lived access tokens (hours/days).** A leaked token is valid for the entire lifetime. 15 minutes is the standard; refresh as needed.
5. **Refresh tokens that don't rotate.** A leaked refresh token is forever-valid. Rotation + theft detection makes leaks bounded.
6. **Storing tokens in `localStorage`.** XSS can steal them. `httpOnly` cookies for refresh, in-memory for access — and even then, modern guidance leans toward Backend-for-Frontend session cookies.
7. **Custom claim called `tenant_id` but never validated against the registry.** A malicious actor mints a token with their own claim — wait, they can't, because they need Keycloak's signing key. But the lesson is real: don't trust claims for critical decisions without cross-checking against the registry.
8. **RLS policy that recurses.** Symptom: `stack depth limit exceeded`. Cure: `SECURITY DEFINER` helper.
9. **Forgetting that `BYPASSRLS` is a foot-gun.** Any role with `BYPASSRLS` ignores all policies. Limit it to migration roles and definer-function owners; never grant it to `app_user`.
10. **Mixing authn and authz in one guard.** Symptom: refactors that break in surprising ways because two concerns moved together. Separate the guards: `JwtAuthGuard` for who, `RolesGuard` and `ABACGuard` for what.

---

## Stretch goals (optional rabbit holes)

- **SAML federation**: configure an enterprise IdP (Okta/Entra) in Keycloak as an identity broker. Use Keycloak's own dev SAML IdP test feature.
- **MFA (TOTP)**: enable TOTP in the realm; use the Keycloak account console to enroll. Now logins require a second factor.
- **OPA sidecar**: deploy OPA, write the `parent_of_student` policy in Rego, have your service consult OPA via `localhost:8181`. Compare ergonomics with hard-coded guards.
- **SCIM**: configure Keycloak to receive SCIM user provisioning from a test enterprise system. The user lifecycle (joiner / mover / leaver) becomes API-driven.
- **Token introspection**: implement the hybrid pattern (JWT validate + introspect for high-value ops).
- **Step-up auth**: certain admin operations require a fresh authentication (re-prompt for password/MFA). Common in banking; a senior posture for sensitive education actions (e.g., grade overrides).
- **Read RFC 9700 (OAuth 2.0 Best Current Practice)** in full. It's dense; it pays off.

---

## Reflection questions

1. **Why does PKCE exist?** Walk through the attack it prevents (authorization code interception in a public client).
2. **Token introspection vs JWT validation: when does each win?** Frame in terms of latency budget and revocation requirements.
3. **You picked single-realm with `tenant_id` claim. State the conditions under which the choice flips to realm-per-tenant.**
4. **A user's session must be revoked immediately (HR off-boarding). What's the path with rotated refresh tokens? What's the gap, and how does introspection close it?**
5. **The RLS policy uses a `SECURITY DEFINER` function. Why doesn't this re-create the recursion problem?** Walk through the privilege boundary.
6. **A parent A authorizes correctly at the BFF, but a bug in the SIS service skips the ABAC check. What stops the leakage?** (Defense in depth — name the layer.)
7. **An attacker steals a refresh token via XSS. With rotation enabled, how does theft detection fire, and what's the user-visible result?**

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §6.3 (auth flows), §6.4 (authz).
- **OpenID Connect Core 1.0 spec** — `openid.net/specs/openid-connect-core-1_0.html`. Specifically sections 3 (auth flows) and 5 (claims).
- **OAuth 2.0 Best Current Practice (RFC 9700)** and **OAuth 2.1 draft**.
- **Keycloak documentation** — *Server Administration Guide* and the *Securing Applications* guide.
- **OWASP API Security Top 10** — A01, A02, A05 are the relevant ones.
- **`oauth.net`** — Aaron Parecki's excellent annotated walkthroughs.
- **Auth0 blog**: their JWT and OIDC explainers are some of the clearest on the internet.
- **Nile blog** — *RLS recursion via `SECURITY DEFINER`* (the production bug story).

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.6 to `Done`. Move to milestone 1.7 (BFF as JSON aggregator). With identity finally settled, the last application layer goes in.
