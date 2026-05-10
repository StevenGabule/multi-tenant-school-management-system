# ADR-0014: Single realm with `tenant_id` claim (vs realm-per-tenant)

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

ADR-0013 commits us to Keycloak. The next sub-decision: how do we model
*tenants* in the realm?

Two patterns are live in the industry:

1. **Single realm, `tenant_id` claim.** One Keycloak realm. Users carry
   a `tenant_id` user-attribute that's emitted as a JWT claim. Services
   read the claim and scope their queries. RLS on the database side
   enforces the same.

2. **Realm-per-tenant.** Each tenant gets a dedicated Keycloak realm —
   isolated user directory, isolated client config, isolated session
   policy. Users in tenant A literally cannot be enumerated from tenant
   B's realm. The application either keeps a registry of "this tenant
   uses this realm" or uses Keycloak's identity-brokering to federate.

The choice has procurement, security, and operational weight. Picking
the wrong one is expensive — re-realm'ing existing users is a migration
project on the order of weeks.

## Decision

**Phase 1 uses a single realm `sms-platform` with a `tenant_id` claim.
We will graduate to realm-per-tenant (or a hybrid via identity brokering)
when explicit triggers fire.**

### Specific rules

1. **One realm**, named `sms-platform`. Created and configured by
   `infra/keycloak/bootstrap.sh`.

2. **`tenant_id` is a user-profile attribute.** Declared in the realm's
   user-profile schema with admin-only `edit` permission so users
   can't change their own tenant from the account console. Emitted as a
   JWT claim via the user-attribute protocol mapper.

3. **One user, one tenant** (Phase 1). A user who needs access to
   multiple tenants gets one identity per tenant. This is the principal
   limitation of the single-realm-with-claim approach; documented as a
   known limit, not a flaw.

4. **All tenant validation passes through the registry**
   (`@org/tenant-registry`, milestone 1.2). The token's `tenant_id`
   claim is the *first* signal; the registry confirms tenant status
   (active / suspended / deleted) before any tenant-scoped operation.
   The Keycloak token is the source of truth for *who*, the registry
   is the source of truth for *whether the tenant is operating*.

5. **Realm-per-tenant graduation triggers** — we commit to the harder
   migration when ANY of these become true:

   1. **An enterprise customer requires their own SSO IdP.** SAML
      federation against their Okta/Azure AD/etc. is impractical to
      do safely in a shared realm — different MFA policies, different
      session lifetimes, different identity-claim shapes. The clean
      pattern is one realm per federated source.
   2. **A procurement requirement names "no co-mingling" of tenant
      directories.** Some education-vertical procurements explicitly
      forbid one tenant's user list being browsable from another's
      admin console. Realm-per-tenant is the answer; a shared realm
      with strict admin-role scoping is *not* (admin can browse all).
   3. **A compliance regime (FERPA in education, GDPR data residency)
      demands per-tenant audit boundaries** that can't be implemented
      with shared sessions and shared event logs.
   4. **A user genuinely belongs to two unrelated tenants** (e.g., a
      parent at School A and a teacher at School B). Today the
      workaround is "one identity per tenant"; if this becomes common,
      realm-per-tenant + identity-brokering is cleaner.
   5. **A tenant requires a different password / MFA / session policy
      than the rest.** Some districts mandate 90-day password rotation;
      others mandate hardware-token MFA for admin actions. Realm-level
      policy is per-realm by design.

   If NONE of the triggers apply by milestone 2.0 review, we stay on
   single-realm.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Single realm + tenant_id claim (chosen)** | One realm to operate; one set of clients; one set of identity providers; user lookup is one query; trivially supports common B2C cases | Multi-tenant-per-user is awkward; per-tenant SSO can't share the realm; one bad mapper bug leaks tenant context across tenants | n/a — fits Phase 1 perfectly |
| **Realm-per-tenant (eager)** | Strong isolation by construction; per-realm policies (MFA, session); ready for federated SSO | N realms × N clients × N IdP configs to maintain; user provisioning multiplies; the gateway has to discover the right realm per request (subdomain routing, header inspection); tenant onboarding is a heavyweight realm-creation flow | Premature; the operational cost is real and Phase 1 doesn't pay for it |
| **Realm-per-tier** (one realm for all "starter" tenants, separate realms for enterprise) | Hybrid balance | Adds a second discovery dimension (which realm for which tier); doesn't actually solve the multi-tenant-per-user problem | We'd still need per-tenant trigger logic |
| **One realm + per-tenant identity-broker** (Phase 2 candidate) | Lets enterprise tenants federate THEIR IdP into our shared realm; realm stays singular; per-IdP claim mapping | Discovery and routing complexity moves from realm-level to broker-level; some MFA concerns persist | A serious Phase 2 candidate; we'll evaluate when trigger #1 fires |

## Consequences

**Positive:**

- Operational simplicity. One realm to monitor, one bootstrap script,
  one set of clients. Onboarding a tenant is "create a registry row +
  create users with this `tenant_id` attribute" — no realm spin-up.
- All cross-tenant code (gateway, BFF) routes through one IdP. No
  realm-discovery middleware.
- Migrating to realm-per-tenant later is mechanical: each tenant's
  users get exported, imported into a new realm, the registry updated
  to point at the new realm. Painful at scale, but a known
  migration shape.

**Negative / costs:**

- One user, one tenant. A real-world parent-of-two-schools needs two
  accounts. Documented; if this complaint accumulates, it's a
  graduation trigger.
- The realm's admin console can browse ALL users across ALL tenants.
  Fine when the operator IS the platform team; awkward if a partner
  needs scoped admin access (Phase 2 problem).
- A bug in the `tenant_id` mapper or claim validation could leak
  tenant context. Mitigation: the claim is double-checked against the
  registry on EVERY request, AND RLS at the database is the second
  line of defense (see ADR-0005). Three layers (mapper, registry,
  RLS) all aligned to fail closed.

**Risks:**

- **A user-profile schema change in Keycloak** (e.g., new field added
  with `unmanagedAttributePolicy` left default) could silently drop the
  `tenant_id` attribute. Mitigation: the bootstrap script declares the
  attribute explicitly and sets `unmanagedAttributePolicy=ENABLED`;
  the script is idempotent and is the source of truth.
- **Admin compromise risk.** The admin user can see all tenants. Same
  as any platform-admin role; mitigated by limiting the admin to one
  human, rotating credentials, MFA at the realm level.
- **Federation request from an early enterprise tenant** (procurement
  asks for SAML before we're ready). We'd accelerate the realm-per-
  tenant graduation. Documented as the #1 trigger.

**Follow-up work this enables / forces:**

- Milestone 1.7 (BFF): the BFF reads `tenant_id` from the validated
  token + uses it to fan out per-tenant data calls. No realm-discovery
  to worry about.
- Phase 2 trigger response: when the first trigger fires, the path is:
  (a) decide identity-brokering vs full realm-per-tenant per the
  specific trigger; (b) build the realm-discovery middleware at the
  gateway; (c) migrate the existing tenant's users (largest tenant
  first). Each step has an ADR.
- Phase 2 ESLint rule: any direct admin-API call to Keycloak that
  spans tenant scopes is rejected — encourages going through the
  bootstrap script or a future tenant-onboarding service.

## References

- Keycloak Server Administration Guide, *Realms* and *User Profiles*.
- *Practical Multi-Tenancy with Keycloak* (community blog posts circa
  2023–2025; the consensus is "single realm until enterprise
  federation, then per-realm or broker").
- Internal:
  - `infra/keycloak/bootstrap.sh` — realm + user profile config
  - `libs/auth-keycloak/src/lib/keycloak-jwt.types.ts` — `tenant_id`
    claim type
  - `libs/tenant-registry/` — the registry that double-checks the
    claim against tenant status
- Phase 1.6 milestone: [`../phase-1/06-iam-keycloak.md`](../phase-1/06-iam-keycloak.md)
- Related: [ADR-0013](0013-iam-backbone.md) (the IAM choice this
  realm strategy lives inside)
- Related: [ADR-0005](0005-rls-tenant-isolation.md) (the database-
  layer enforcement that backs the claim)
