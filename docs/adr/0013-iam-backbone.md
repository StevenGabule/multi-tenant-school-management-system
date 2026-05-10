# ADR-0013: Keycloak as the IAM backbone

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Milestone 1.1 introduced a hand-rolled JWT — `@nestjs/jwt` signing with
a shared `JWT_SECRET`. Milestones 1.2–1.5 piggybacked on it. The whole
arrangement was a stepping stone, not an architecture: HMAC-shared-secret
across services means anyone with the secret can mint tokens for anyone;
no JWKS rotation; no introspection; no refresh-token rotation; no
session revocation. Auth bugs are the highest-impact bugs, and the
hand-rolled flow was the largest unaudited surface in the project.

For milestone 1.6 we replace it with a real OIDC provider. Three plausible
choices in 2026:

1. **Keycloak** — open-source, self-hosted, Java; rich realm/client/role
   model, JWKS rotation, refresh-token rotation, theft detection, SAML
   federation, SCIM. Operational footprint: a JVM container plus the
   provider DB.
2. **Auth0 / Okta / Entra** — managed SaaS. Zero ops, premium pricing,
   data lives at the vendor, vendor-specific lock-in (especially around
   custom claim mappers).
3. **Continue hand-rolling** — keep the hand-rolled JWT and harden it
   with JWKS, rotation, etc. Build all of OIDC ourselves.

The cost dimension matters: this is a one-engineer learning project, but
the architecture choices need to make sense at production scale too. Auth
is one of the few areas where "right for solo dev today" and "right at
scale" can land on the same answer.

## Decision

**Phase 1 IAM backbone is self-hosted Keycloak (`quay.io/keycloak/keycloak:25`).**

We adopt Keycloak as the source of identity and the issuer of access
tokens. Every service validates tokens via OIDC discovery + JWKS — the
hand-rolled `JwtAuthGuard` is fully retired. The shared lib
`libs/auth-keycloak` is the single source of truth for the validation
pipeline.

### Specific rules

1. **One realm: `sms-platform`.** Multi-tenant via a `tenant_id` user-
   attribute mapper; not realm-per-tenant. ADR-0014 documents this
   choice and the conditions under which it flips.

2. **Two clients per realm:**
   - `gateway` — public client (no secret), authorization code + PKCE
     for the (future) UI, direct-access-grants enabled in dev for the
     password-grant smoke flow that replaces the milestone-1.1
     `/api/dev/token` endpoint.
   - `services` — confidential client, service-account enabled,
     client-credentials grant for service-to-service calls (saga
     executor → SIS / academic-service).

3. **Five realm roles** in a code-encoded hierarchy:
   `district-admin > school-admin > teacher`, `parent` and `student` are
   leaves. Hierarchy lives in `libs/auth-keycloak/src/lib/roles.guard.ts`
   (not Keycloak composite roles) so engineers can audit it in one
   place; ADR-0011 has the matching argument for the saga.

4. **Custom claim `tenant_id`** emitted via a user-attribute protocol
   mapper. Users have a `tenant_id` profile attribute (declared in the
   realm's user-profile schema, with admin-only edit permission so users
   can't change their own tenant). Single-tenant-per-user today — the
   limit is documented in ADR-0014.

5. **Audience mapper** on the gateway (and services) client adds
   `aud=gateway` to access tokens. Default Keycloak `aud=account` would
   fail every service's audience check; this fixes the wiring at the
   issuer side, not by relaxing the consumer side.

6. **Service-to-service** via the `services` confidential client's
   client-credentials grant. Tokens are cached by the caller (refresh
   ~80% through their lifetime); a single inflight fetch is gated so a
   burst of saga steps doesn't trigger N parallel token requests.
   Tenant context per-request via `X-Tenant-Id` header — service tokens
   carry no tenant_id by design (they're tenant-agnostic identity).
   `KeycloakAuthGuard` accepts the header ONLY when the token is
   recognizably a service-account token (`preferred_username` starts
   with `service-account-`).

7. **JWKS via `createRemoteJWKSet` (jose).** 10-minute cache; refresh on
   unknown `kid` with a 30-second cooldown to prevent DDoS via tokens
   carrying random kids. Validates `iss`, `aud`, `exp`, `nbf`, signature.

8. **Refresh-token rotation + theft detection** is configured at the
   realm level (`revokeRefreshToken=true`, `refreshTokenMaxReuse=0`). A
   refresh token used twice triggers full session revocation — the
   second use is treated as theft, not a duplicate request.

9. **The hand-rolled `/api/dev/token` endpoint is GONE.** Replaced by
   `infra/keycloak/mint-token.sh` for tests — sets the dev-tester
   user's tenant_id attribute and runs the OIDC password grant. This
   is the same code path real users would take (just shortcut to the
   token endpoint without the redirect dance).

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Hand-rolled JWT (current state)** | Zero new infra; trivially understood | No JWKS rotation; HMAC means shared secret = mint authority; no refresh rotation; no session revocation; every service is a forging attack surface; reinventing OIDC poorly | Auth is the highest-impact attack surface — using a battle-tested IdP is the senior move |
| **Keycloak (chosen)** | Industry-standard OIDC + OAuth 2.1; JWKS rotation; refresh-rotation + theft detection; SAML/SCIM extension points for enterprise tenants; self-hosted (data stays inside our cluster); rich admin console + kcadm.sh CLI for IaC; mature open-source community | JVM footprint (~512MB heap); one more service to operate; admin console is legacy GWT-flavored UX | n/a — accepted operational cost for a battle-tested IdP |
| **Auth0 (managed)** | Zero ops; great DX; built-in social login | Vendor pricing scales aggressively past hobby tier; data at vendor (compliance burden in education vertical); custom-claim mapping locked into vendor's "Action" ecosystem | Right for many teams; wrong for an education-domain product where data residency matters and we want full control of the realm config |
| **Okta / Entra ID (managed)** | Enterprise-grade SSO; SCIM-first; strong B2B story | Same lock-in concerns as Auth0; pricing premium; less open to deep customization | Same |
| **Ory Hydra + Kratos** | Cloud-native, modular (auth-server vs identity-server split), well-documented | Two services + a database for what Keycloak does in one; we'd be the unusual shop running Ory in 2026 | Marginal benefit over Keycloak; ecosystem smaller |
| **Zitadel** | OIDC + SAML, modern UX, lightweight Go binary | Smaller community than Keycloak; fewer hires-with-prior-experience | Keycloak is the industry default for self-hosted OIDC |

## Consequences

**Positive:**

- Single source of identity. Realm config is in version control
  (`infra/keycloak/bootstrap.sh`); the realm can be rebuilt from scratch
  in ~10 seconds.
- Validation logic lives ONCE in `libs/auth-keycloak`. Services consume
  it; no service has its own auth code. Future security improvements
  ship to all services in one PR.
- JWKS rotation is automatic. Keycloak rotates its signing key on a
  schedule; jose's `createRemoteJWKSet` refetches on unknown kid.
  Outages from key rotation that took down the hand-rolled-JWT world
  are gone.
- Refresh-token rotation + theft detection is a configuration toggle,
  not code we maintained.
- Service-to-service auth is now genuine OAuth 2.1 client-credentials,
  not a forged JWT signed with a shared secret. Compromise of one
  service's secret revokes that service, not the whole realm.
- The path to enterprise federation (SAML, SCIM, OIDC-broker) is open —
  Keycloak ships those features. We don't have to rip-and-replace when
  the first enterprise tenant arrives.

**Negative / costs:**

- ~512MB JVM heap, plus the Keycloak DB. On a developer laptop this is
  noticeable; on a production deployment, irrelevant.
- One more thing to operate. Keycloak upgrades are non-trivial (major
  versions occasionally break realm export/import); we accept this.
- Admin console UX is legacy. kcadm.sh CLI is the more maintainable
  surface; the bootstrap script reflects this.
- Bootstrap script must be re-run after every fresh Keycloak DB. Solved
  by making it idempotent and committing it to the repo.

**Risks:**

- **The realm bootstrap script is the only source of truth for realm
  config.** If someone makes a change in the admin console without
  updating the script, the next fresh deploy diverges. Mitigation: the
  script comment + a runbook entry "all realm changes via the script,
  not the console."
- **Token introspection is NOT YET wired.** Validation is JWT-signature-
  only; a token revoked at Keycloak is still valid in flight until exp.
  Acceptable today (15-min token lifetime caps damage); milestone 1.8
  may add introspection for high-value endpoints. Documented in the
  milestone DoD as deferred.
- **Service-token `X-Tenant-Id` header is trusted on receipt.** The
  guard validates that the token is a service token (preferred_username
  prefix) before reading the header. If a service-account user is ever
  reused for non-machine purposes, this premise breaks. Mitigation:
  service-accounts in Keycloak are clearly labeled; convention + the
  prefix check; revisit if it ever bites.
- **Single point of failure.** If Keycloak is down, no new logins, no
  service-to-service calls. Mitigation: high-availability Keycloak in
  Phase 2 (Postgres-backed cluster). Acceptable risk for Phase 1.

**Follow-up work this enables / forces:**

- Milestone 1.7 (BFF): the BFF layer fronts Keycloak's PKCE flow for
  the eventual UI. The BFF holds the refresh token in an httpOnly
  cookie; the access token is in-memory client-side.
- Phase 2: token introspection for high-value operations (admin
  actions, financial transactions if/when relevant).
- Phase 2: SAML federation for enterprise tenants (one-realm-per-IdP
  via Keycloak's identity-broker feature, not realm-per-tenant — see
  ADR-0014).
- ESLint rule (Phase 2): any direct `jwt.sign` / `jwt.verify` is
  rejected outside `libs/auth-keycloak`.

## References

- OpenID Connect Core 1.0: <https://openid.net/specs/openid-connect-core-1_0.html>
- OAuth 2.0 Best Current Practice (RFC 9700)
- Keycloak Server Administration Guide (the relevant chapters: Clients,
  Roles, Sessions, Token Lifespan)
- jose library: <https://github.com/panva/jose>
- Internal:
  - `infra/keycloak/bootstrap.sh` — realm IaC
  - `infra/keycloak/mint-token.sh` — test-time token replacement for
    the deleted /api/dev/token endpoint
  - `libs/auth-keycloak/` — the validation lib (KeycloakService,
    KeycloakAuthGuard, RolesGuard)
  - `apps/enrollment-service/src/sagas/cross-service.client.ts` — the
    service-to-service token client
- Phase 1.6 milestone: [`../phase-1/06-iam-keycloak.md`](../phase-1/06-iam-keycloak.md)
- Related: [ADR-0014](0014-realm-strategy.md) (single realm vs realm-per-tenant)
- Related: [ADR-0005](0005-rls-tenant-isolation.md) (RLS reads
  tenant_id from the JWT path)
