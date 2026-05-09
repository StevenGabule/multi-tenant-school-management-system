# ADR-0001: Tiered hybrid tenancy model (Pool / Bridge / Silo)

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

This is a multi-tenant SaaS system targeting K-12 school districts at a planning horizon of ~1,000 schools and tens of millions of users. The single most consequential, hardest-to-reverse decision in such a system is the **tenancy model** — how customer data is separated and how the same application serves many customers.

Three forces are in tension:

1. **Cost economics.** A free-tier or standard-tier customer cannot economically justify dedicated infrastructure. At 1,000+ tenants, anything other than shared infrastructure for the long tail is financially infeasible.
2. **Compliance and procurement.** Ministries of education, large districts, and customers in jurisdictions with strict data-residency laws (Russia, China, parts of Germany, KSA) routinely require contractual evidence of physical or logical isolation that shared infrastructure cannot provide.
3. **Operational sanity.** A model that requires per-tenant migrations, per-tenant connection pools, or per-tenant Kubernetes namespaces does not scale to 1,000+ tenants without a disproportionate platform team.

The AWS SaaS Lens taxonomy of **Silo / Bridge / Pool** is the industry-standard framing for this decision. AWS, Microsoft Azure, Cloudflare, and Nile have all published variations of the same conclusion: pick *per service and per customer tier*, not one model for the whole system.

This is also a learning project. The choice must expose the engineer to the production realities of all three models — pure Pool would teach RLS but skip silo migration mechanics; pure Silo would teach connection-pool-per-tenant but skip RLS entirely.

## Decision

**We will adopt a tiered hybrid tenancy model:**

- **Pool tier (default):** All standard-tier tenants share a single PostgreSQL cluster per region. Isolation enforced by Row-Level Security (RLS) with `FORCE ROW LEVEL SECURITY` and a transaction-scoped GUC (`app.current_tenant_id` set via `SET LOCAL`).
- **Silo tier (premium / regulated):** Dedicated PostgreSQL database for tenants requiring contractual isolation, regional residency, or per-tenant KMS. Same application code base; the tenant registry routes to the correct DSN at request time.
- **Bridge tier (transient only):** Schema-per-tenant used **exclusively** as a migration intermediate when promoting a tenant from Pool to Silo. Never offered as a permanent product tier.

The tenant registry (a single global "control plane" database, owned by the Tenant service) stores the tier and DSN for every tenant; every other service consults it on startup and routes queries accordingly.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Pure Pool (RLS only)** | Cheapest, simplest operations, single migration applies to all | Cannot satisfy ministry-grade isolation contracts; noisy-neighbor risk; backups not per-tenant | Excludes a real customer segment we plan to serve |
| **Pure Silo (DB per tenant)** | Strongest isolation; trivial per-tenant backup/restore; per-tenant performance tuning | Infeasible cost economics at 1,000+ tenants; per-tenant migrations are an operational treadmill; Prisma connection pool per tenant explodes connections | Cost economics fail at scale |
| **Pure Bridge (schema per tenant)** | Better isolation story to procurement than Pool; per-schema dump possible | `pg_catalog` performance degrades past ~5,000–10,000 schemas; PgBouncer struggles with `search_path`-aware pooling; Prisma issue #12420 (dynamic schema switching) is open | Hard scaling wall; tooling friction |
| **Tiered hybrid (Pool + transient Bridge + Silo) — chosen** | Cost-efficient for the long tail, isolation-strong for the regulated segment, learning project covers all three patterns | Requires a control-plane registry from day one; tenant promotion is a real engineering procedure | n/a |

## Consequences

**Positive:**

- The tenant registry is now the **most important service** in the system — it must be built first, before any feature service. This forces good control-plane discipline early.
- RLS becomes a non-negotiable safety net. Every table gets `tenant_id NOT NULL`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and a tenant-isolation policy from line one.
- The same stateless service binaries run for both pool and silo customers — no per-tier code paths, only DSN routing.

**Negative / costs:**

- Two database connection strategies must be supported in code: a single `PrismaClient` for the pool tier, and an LRU-cached `PrismaClient` factory for the silo tier. This is a recurring source of subtle bugs and is the topic of Phase 1 milestone 1.1.
- Tenant promotion (Pool → Silo) is a multi-step procedure involving filtered `pg_dump`, Debezium CDC, dual-write windows, and verification. Treat as a quarterly engineering project, not an ops button.
- The control-plane registry becomes a single point of dependency for every other service's startup. Aggressive caching and a strong fallback policy are required.

**Risks:**

- **RLS GUC leakage** under PgBouncer transaction mode if a developer ever uses `SET` instead of `SET LOCAL`. Mitigation: a `PrismaService` extension that asserts the GUC and refuses to issue queries without it; CI integration test that creates two tenants and asserts cross-tenant queries return zero rows.
- **Connection pool exhaustion** on the pool DB if many silo `PrismaClient` instances are created without a TTL eviction. Mitigation: LRU cap of ~200, TTL 30 min, fronted by PgBouncer in transaction mode.
- **Bridge tier scope creep.** Once schema-per-tenant exists for migration, there will be temptation to expose it as a product tier. Mitigation: the tier is named "transient" in the registry schema and any tenant in Bridge state for >30 days raises an alert.

**Follow-up work this enables / forces:**

- Phase 1 milestone 1.1 (RLS) and 1.2 (tenant registry) are direct consequences.
- Phase 2 will need: Citus introduction tripwire (when pool DB primary > 70% CPU sustained), per-tenant KMS for silo tier, tenant promotion automation.
- Pricing model must distinguish at least three tiers (free, standard pool, enterprise silo); coordinate with the eventual Fees service.

## References

- AWS SaaS Lens: *SaaS Tenant Isolation Strategies* (whitepaper)
- AWS Database Blog: *Multi-tenant SaaS storage strategies on Amazon RDS for PostgreSQL*
- Microsoft Azure Architecture Center: *Multitenancy and Azure Database for PostgreSQL*
- Nile Database blog: *Shipping multi-tenant SaaS using Postgres RLS* (production gotchas)
- Cloudflare Engineering: *Performance isolation in a multi-tenant database environment*
- Citus Data: *Multi-tenant SaaS sharding patterns*; `isolate_tenant_to_new_shard()` documentation
- Project root: `documentation.md` §2 (Multi-Tenancy Deep Dive)
