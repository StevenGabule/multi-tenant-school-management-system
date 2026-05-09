# Phase 1.2 — Tenant registry as control plane

> **Concepts:** control plane vs data plane, two-database architecture, tenant registry, region/tier/feature-flag metadata, multi-layer registry caching (in-memory LRU + Redis), pub/sub invalidation, fail-open vs fail-closed, the "everything depends on this" service
> **Estimated effort:** 2 weekends
> **Status:** Not Started
> **Prerequisites:**
> - Milestone 1.1 complete (RLS, GUC, cross-tenant test passing)
> - Redis running locally (add to docker-compose if not already)
> - Read [`../../documentation.md`](../../documentation.md) §1 (service #1 Tenant), §10 Recommendation #1

---

## What you'll learn

- The control plane / data plane distinction and why mixing them in one database is one of the worst architectural decisions you can make in multi-tenant SaaS.
- How to run two PostgreSQL databases (a global control-plane DB and a regional tenant-data DB) from a single Prisma-based codebase using multi-schema generation.
- The shape of a tenant registry: identity, tier, region pinning, lifecycle state, DSN routing for the silo tier, feature flags.
- Multi-layer caching for hot lookups: in-process LRU (microsecond), Redis (millisecond), database (single-digit ms), with TTL + pub/sub invalidation for fast propagation.
- The fail-open vs fail-closed decision when the registry is unreachable, and why it's an ADR-worthy security tradeoff.
- The "every service depends on this" property — and the operational implications (it must be the most reliable, most cached, most monitored service in the system).

---

## Why this matters (senior perspective)

The tenant registry is the **single most consequential service in a multi-tenant SaaS**, and the most commonly underbuilt. Teams that skip it pay for it twice: once when they realize tenant-routing logic is duplicated across every service and contradicting itself, and again when they try to retrofit a registry into a system where every service has been making its own assumptions about tenant identity.

The reason it gets skipped is that on day one, with one tenant, the registry adds friction with no visible payoff. By tenant 50, the payoff is "we can suspend a tenant in 60 seconds without a deploy." By tenant 500, it's "we can promote a tenant from pool to silo without writing a custom script." By tenant 1,000, it's "we know where every tenant's data is, and we can prove it to a regulator within 5 minutes."

The senior posture: **the most important service is the one nobody notices until it goes down.** Build it deliberately, cache it aggressively, monitor it like infrastructure.

The fail-open/fail-closed decision is the second senior moment. When the registry is unreachable, you face a choice:

- **Fail closed (deny all):** every request returns 503 because no service can resolve its tenant. Customers see total outage.
- **Fail open (admit unknown):** services use last-known-good tenant data from cache. Customers continue to work; suspended tenants might briefly remain active.

There's no universally correct answer; there's only a *defended* answer. Senior engineers have an ADR for this.

---

## Hands-on plan

### Step 1 — Decide the two-database architecture

Two physical databases (or two logical databases on the same cluster, for now):

- **`control_plane_db`** — owned by `tenant-service`. Tables: `Tenant`, `District`, `School`, `Plan`, `FeatureFlag`, `TenantEvent` (for audit). **No RLS.** This data is not tenant-scoped; it *describes* tenants.
- **`tenant_data_db`** — the database from milestone 1.1. Holds all tenant-scoped data with RLS. Eventually one per region; for now, one.

Your existing `gateway` and any future feature service connects to `tenant_data_db`. The new `tenant-service` connects to `control_plane_db`. Two separate connection strings, two separate Prisma schema files.

### Step 2 — Generate the tenant-service

1. `nx g @nx/nest:app tenant-service`.
2. Create `apps/tenant-service/prisma/schema.prisma` pointing at the control plane DB.
3. Define the entities:

```
Tenant {
  id          uuid PK
  name        text
  slug        text unique             // for URLs, e.g. "lincoln-district"
  tier        enum(pool, bridge, silo)
  region      text                    // e.g. "us-east-1"
  status      enum(pending, active, suspended, migrating, terminated)
  dsn         text nullable           // populated for silo tier; the connection string for that tenant's DB
  plan_id     uuid FK -> Plan
  created_at  timestamptz
  suspended_at timestamptz nullable
}

District {
  id        uuid PK
  tenant_id uuid FK -> Tenant
  name      text
}

School {
  id          uuid PK
  district_id uuid FK -> District
  name        text
}

Plan {
  id          uuid PK
  name        text                    // "free", "standard", "enterprise"
  features    jsonb                   // {"attendance": true, "fees": false, ...}
  rate_limits jsonb                   // {"rps": 1000, "writes_per_min": 5000}
}

FeatureFlag {
  id        uuid PK
  tenant_id uuid FK -> Tenant nullable  // nullable means global
  key       text
  enabled   boolean
  // tenant overrides; if no tenant override exists, the plan's flag wins.
}

TenantEvent {
  id        uuid PK
  tenant_id uuid FK -> Tenant
  type      text                    // "created", "suspended", "promoted_to_silo", ...
  payload   jsonb
  actor_id  uuid                    // who initiated
  at        timestamptz
}
```

4. Run `prisma migrate dev --name init-control-plane`. Verify the migration is in version control and applied.

**Why no RLS:** the control plane is consulted by *every* service to resolve tenants. If it had RLS, services would need to set the GUC before consulting it — but the GUC value is what they're trying to look up. Chicken-and-egg. Control-plane access is restricted by API authentication and role, not row-level security.

### Step 3 — Tenant-service API

Build a thin REST API on tenant-service:

- `POST /tenants` — create a new tenant. Body: name, tier, region, plan_id. Returns the new tenant. Restricted to platform admins (use a hardcoded API key + admin JWT until milestone 1.6).
- `GET /tenants/:id` — fetch by id. Used by service-to-service lookups.
- `GET /tenants/by-slug/:slug` — fetch by URL slug. Used by the gateway to resolve tenants from subdomain routing.
- `PATCH /tenants/:id` — update tier, region, status, dsn. Append a `TenantEvent` for every change.
- `POST /tenants/:id/suspend` — sets status to `suspended`, suspended_at to now. Publishes an invalidation event.
- `GET /plans` and `GET /plans/:id` — for plan resolution.
- `GET /feature-flags?tenant_id=...&key=...` — resolves a flag with tenant-override semantics.

Keep the tenant-service "boring" — it's a metadata CRUD service, not a business engine. Domain logic belongs elsewhere.

### Step 4 — Tenant registry client library

Build `libs/tenant-registry/` as a shared library every service imports.

The client exposes:

```
TenantRegistry.findById(id: UUID): Promise<Tenant | null>
TenantRegistry.findBySlug(slug: string): Promise<Tenant | null>
TenantRegistry.isFeatureEnabled(tenantId: UUID, key: string): Promise<boolean>
TenantRegistry.invalidate(tenantId: UUID): void
```

Inside, a three-layer cache:

1. **Process-local LRU** (capacity ~10,000 entries, TTL 60s) — microsecond hits, no network.
2. **Redis** (TTL 5 min) — millisecond hits, shared across pods.
3. **HTTP call to tenant-service** — fallback; the slowest path.

On a write to tenant-service (create, update, suspend), tenant-service publishes a Redis pub/sub message: `tenant:invalidated:{tenantId}`. Every service subscribed to this channel evicts its local LRU entry for that tenant. The Redis cache TTL provides eventual consistency even for services that miss the pub/sub message (e.g., a pod that just started).

This is the Conway pattern: pub/sub for fast propagation (good case) + TTL for eventual consistency (degraded case).

### Step 5 — Gateway integration

Modify the gateway's `JwtAuthGuard` (or add a follow-up middleware):

1. Validate the JWT signature and extract `tenantId` (as in milestone 1.1).
2. Call `TenantRegistry.findById(tenantId)`. If null → 401 (the JWT is for a deleted tenant).
3. If `tenant.status === 'suspended'` or `'terminated'` → 403 with a message.
4. Cache the resolved Tenant on the request object.
5. Set `tenantId` in CLS as before.

The cross-tenant integration test from milestone 1.1 still applies. Add a new test: suspending a tenant and confirming subsequent requests fail within 60 seconds (the LRU TTL upper bound). This verifies the cache invalidation actually works.

### Step 6 — The fail-open/fail-closed decision

Three layers can fail independently:

- **Local LRU miss + Redis down + tenant-service down**: complete registry blackout.
- **Local LRU has stale data + Redis missed an invalidation**: brief stale reads (acceptable up to TTL).
- **Tenant exists but registry says null**: data corruption or new tenant not yet propagated.

You must decide and document:

- What does the gateway do if all three layers fail? **Recommended: fail closed.** Return 503 with `Retry-After: 30`. The alternative (fail open with cached data) risks serving suspended/deleted tenants.
- Exception: `/livez` and `/readyz` should not require a registry hit (they don't have a tenant context).
- Internal service-to-service calls receive the resolved Tenant from the upstream gateway (passed via JWT or context header), so they don't independently re-resolve. This is one reason the gateway is the registry's "first-mile" cache.

Write the ADR ([`adr/0005-registry-failure-mode.md`](../adr/)) defending your choice.

### Step 7 — Aggressive caching with version awareness

A subtle bug: if you cache `Tenant.tier` and the tenant is promoted from pool to silo, services with stale cache will continue to query the pool DB for that tenant — but the data has been migrated. The result: silent data unavailability.

Pattern: include a `version` (monotonic integer) on every Tenant row. The DSN-routed Prisma client includes the tenant version in its identity. If the version changes, the cached Prisma client is evicted and a new one created.

For pool-tier tenants this is irrelevant (one shared client). For silo tenants this becomes critical in milestone-3.0 (silo tier productized). Build the version field now; you'll thank yourself later.

### Step 8 — Observability for the registry

The registry is the load-bearing service. Every metric goes here:

- **Cache hit rate per layer.** Local LRU hit %, Redis hit %, DB fallback %.
- **Resolution latency p99.** Should be < 1ms for cache hit, < 20ms for DB fallback.
- **Invalidation propagation lag.** The time between tenant-service writing and last subscribed pod evicting its LRU. Should be sub-second.
- **Registry availability.** Errors per minute on `findById`. SLO: 99.99% (more 9s than your data services — because your data services depend on it).

Add a Grafana panel for these metrics now. You'll thank yourself in milestone 1.8 when the dashboard already exists.

### Step 9 — Write the ADRs

At least two:

- [`adr/0005-registry-failure-mode.md`](../adr/) — fail-open vs fail-closed.
- [`adr/0006-control-plane-database-strategy.md`](../adr/) — separate physical DB vs logical DB on same cluster, including when to split.

---

## Definition of done

- [ ] `tenant-service` exists as a separate NestJS app with its own Prisma schema and database.
- [ ] Tenant, District, School, Plan, FeatureFlag, TenantEvent models exist in the control plane DB.
- [ ] `libs/tenant-registry/` client implements three-layer cache (LRU → Redis → DB).
- [ ] Gateway resolves the tenant on every authenticated request via the registry client.
- [ ] Suspending a tenant via `POST /tenants/:id/suspend` causes subsequent requests in other services to fail within 60s.
- [ ] Pub/sub invalidation working (verifiable: subscribe to the channel manually with `redis-cli SUBSCRIBE`, watch messages flow on a write).
- [ ] Registry cache hit rate metric exposed and visible in Prometheus.
- [ ] Failure-mode behavior tested: kill the registry; confirm requests return 503, not garbage.
- [ ] Cross-tenant integration test from milestone 1.1 still passes.
- [ ] ADR-0005 (failure mode) and ADR-0006 (DB strategy) written.

---

## Common pitfalls

1. **Putting the registry in the same database as tenant data.** Mixing control plane and data plane means the registry and the data have the same blast radius — exactly what you don't want.
2. **No caching layer.** Hitting the registry's database on every request makes it the system's hottest table and a single point of latency.
3. **TTL-only invalidation.** When a tenant is suspended for security reasons, "wait up to 5 minutes" is unacceptable. Pub/sub closes the gap.
4. **Local LRU without a TTL.** A pod that's been alive for hours holds infinitely stale data if pub/sub ever misses. Belt and suspenders.
5. **Failing open by default.** Defaults dictate culture. If "tenant not found → admit them" is the default, every new feature inherits the lax stance.
6. **Mutating tenants without a `TenantEvent`.** The audit trail is the only way to reconstruct "why is this tenant suspended?" three months later.
7. **Single-region registry for a multi-region system.** When you go multi-region in Phase 2, the registry's region strategy becomes a Phase 2 ADR. Don't paint yourself into the wrong corner now — leave the option open.
8. **No DSN field on Tenant.** Without it, silo-tier routing requires a separate service. Add the field now even though pool-tier tenants don't use it.
9. **Resolving the tenant inside every microservice independently.** This duplicates the cache and the failure mode. Resolve once at the gateway, pass the resolved Tenant downstream.
10. **Skipping the registry-availability SLO.** If the registry is 99.9% available and 5 services each independently need it, the system's availability is 99.9%^5 = 99.5%. You need the registry to be more reliable than anything that depends on it.

---

## Stretch goals (optional rabbit holes)

- **Add a CLI for tenant operations.** `pnpm tenant:create --name "X" --tier=pool` calls the API. CLI tooling is a senior productivity habit.
- **Implement region-aware routing.** Tenant has `region: "us-east-1"`; the gateway forwards requests for `eu-west-1` tenants to the EU gateway. Even with one region, build the forwarding logic — it's harder to retrofit.
- **Build a `/admin` BFF for tenant operations** so platform admins have a non-CLI surface. Skip the UI; expose JSON endpoints.
- **Add tenant lifecycle webhooks.** When status changes, POST to a configured URL. Useful for billing integrations, customer notifications.
- **Implement soft-delete on tenants** with a 30-day grace period before hard-delete. The hardest part is making sure all dependent services drop their data on hard-delete (use the `tenant.deleted` event from milestone 1.4).
- **Stress-test the registry.** Generate 10,000 tenant lookups/sec with `k6`. Where does it break? What's the bottleneck?
- **Build a "tenant inventory" report** — given a region, list all tenants, their tier, their last-used timestamp. The kind of report support and finance teams will eventually beg for.

---

## Reflection questions

1. **What goes in the control plane vs the data plane?** Could you defend the split using only the words "blast radius"?
2. **Why does the local LRU exist if Redis is also a cache?** When does the LRU pay off, and what's its failure mode?
3. **Fail open or fail closed?** Defend your choice in writing. Could the opposite choice ever be right? In what scenario?
4. **Pub/sub invalidation is best-effort. What guarantees does TTL provide that pub/sub doesn't?** What guarantees does pub/sub provide that TTL doesn't?
5. **The registry is more critical than any service that depends on it. What does that mean for its SLO and on-call posture?**
6. **A tenant is promoted from pool to silo. Walk through every service that needs to know, and how it learns.**
7. **Suppose the registry's database fills up and refuses writes. What's the user-visible failure mode? Could you have known about it earlier?**

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §1 (Tenant & Provisioning service), §2.5 (Tenant migration pool → silo), §10 Recommendations #1.
- **AWS SaaS Lens:** *Tenant Onboarding* and *Tenant Identity Management* sections.
- **Microsoft Azure docs:** *Multitenant control plane patterns*.
- **Stripe Engineering:** *Stripe's API design — idempotency keys and tenant isolation* (analogous patterns).
- **Sam Newman, *Building Microservices* (2nd ed.):** Chapter 5 *Splitting the Monolith* — the database-per-service principle.
- **Patterns: *transactional outbox*, *event-carried state transfer*** — relevant for cache invalidation; preview for milestone 1.4.

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.2 to `Done`. Move to milestone 1.3 (First domain service: SIS). Now that the platform plumbing is in place, you build your first real domain.
