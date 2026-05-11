# Multi-Tenant SMS — Learning Roadmap

A learning-frame roadmap for a multi-tenant school management system. The goal is **not** to ship a product; the goal is to develop senior-level technical depth across distributed systems, multi-tenancy, and production engineering by building the smallest viable system that exercises every load-bearing pattern at least once.

> If you wanted to ship fast, you would build less. You are building this to learn deep — the pattern coverage is the curriculum, not the feature surface.

---

## How to use this roadmap

1. **Each milestone is a stop, not a sprint.** Stay until the concept is yours. Re-read your own ADR a week later — if it doesn't make sense, you didn't learn it yet.
2. **Honor the Definition of Done.** It's the interview question you couldn't bluff. If you can't tick every box, the milestone isn't done.
3. **Write an ADR for any non-default choice.** See [`adr/README.md`](adr/README.md). Multiple ADRs per milestone is the norm — typically a "what" + "how" pair.
4. **Update the status column below as you progress.** Treat it as a public commitment.
5. **Never skip the reflection questions.** The fastest route from mid-level to senior is forcing yourself to articulate tradeoffs in your own words.

---

## Phase 1 milestones — DONE

The foundation. Multi-tenant data plane + control plane + IAM + observability + DR. Ten milestones, twenty ADRs, one cold drill.

| # | Milestone | Status | Key concepts |
|---|---|---|---|
| 1.0 | [Foundations & walking skeleton](phase-1/00-foundations.md) | ✅ Done | Nx monorepo, NestJS, Prisma, Docker Compose, Kubernetes (kind), OTel, CI |
| 1.1 | [Tenant context done right](phase-1/01-tenant-context.md) | ✅ Done | RLS, `FORCE ROW LEVEL SECURITY`, GUC + `SET LOCAL`, JWT-derived `tenantId`, cross-tenant CI test |
| 1.2 | [Tenant registry as control plane](phase-1/02-tenant-registry.md) | ✅ Done | Two-database model (control plane vs tenant data), registry caching, region/tier metadata |
| 1.3 | [First domain service: SIS](phase-1/03-sis-first-service.md) | ✅ Done | Repository pattern, clean architecture layering, DTO validation, soft-delete under RLS |
| 1.4 | [Outbox + event consumer](phase-1/04-outbox-events.md) | ✅ Done | Transactional outbox, idempotency, ordering — Postgres `LISTEN/NOTIFY` (Phase 1) |
| 1.5 | [First saga: Enrollment](phase-1/05-enrollment-saga.md) | ✅ Done | Orchestrated saga, compensations, durable state machine |
| 1.6 | [IAM with Keycloak](phase-1/06-iam-keycloak.md) | ✅ Done | OIDC flow, JWT validation, RBAC + ABAC ("parent of student X"), refresh tokens |
| 1.7 | [BFF as JSON aggregator](phase-1/07-bff-aggregator.md) | ✅ Done | BFF pattern, parallel aggregation, Redis cache, partial responses |
| 1.8 | [Observability that earns its keep](phase-1/08-observability.md) | ✅ Done | OTel `tenant_id` baggage, Tempo + Prometheus + Loki + Grafana, one operational dashboard |
| 1.9 | [DR drill](phase-1/09-dr-drill.md) | ✅ Done | Backup, restore to sandbox, measured RPO/RTO, cold drill #1 executed |

**Cold drill #1:** 2026-05-10, sms_sis full restore. Measured RTO ~3min. Three issues found + fixed. See [`postmortems/2026-05-10-cold-drill-1.md`](postmortems/2026-05-10-cold-drill-1.md).

**Next drill:** 2026-08-10 (drill #2 — cross-cluster restore + larger volume).

---

## Phase 2 milestones — drafted, not started

Phase 2 turns the unshakable foundation into a multi-region, multi-tier production-shape. Each milestone earns its keep against a real scaling pressure (regulator, customer SLA, second region, frontend client).

| # | Milestone | Status | Key concepts |
|---|---|---|---|
| 2.0 | [Production-readiness — Phase 1 deferrals closed](phase-2/00-production-readiness.md) | 📋 Drafted | pgbackrest + WAL-PITR, Prometheus alert rules + Alertmanager, k6 load test, Pact contract tests, USE metrics (postgres-exporter, redis-exporter), cron-scheduled backups + 35-day lifecycle |
| 2.1 | [Multi-region deployment + data residency](phase-2/01-multi-region.md) | 📋 Drafted | Per-region active-passive Postgres, tenant-pinned region routing, cross-region request rejection, region failure tabletop |
| 2.2 | [Citus + tenant promotion (pool → silo)](phase-2/02-citus-tenant-promotion.md) | 📋 Drafted | Citus distributed Postgres, tenant promotion saga (pool tenant moves to its own silo cluster), zero-downtime cutover |
| 2.3 | [Service mesh — Istio (or Linkerd)](phase-2/03-service-mesh.md) | 📋 Drafted | mTLS between services, retries + timeouts at the mesh layer, canary deploys, network policy gates |
| 2.4 | [Event sourcing for high-velocity domains](phase-2/04-event-sourcing.md) | 📋 Drafted | Event-stream-as-source-of-truth for attendance + discipline + gradebook history; CQRS read projections |
| 2.5 | [Fees + Payments — the money domain](phase-2/05-fees-payments.md) | 📋 Drafted | Idempotent payment intents, double-entry bookkeeping, settlement reconciliation, webhook integrations (Stripe, Razorpay) |
| 2.6 | [Frontend — Next.js + parent portal MVP](phase-2/06-frontend.md) | 📋 Drafted | First real client app; Next.js App Router; Keycloak OIDC PKCE; BFF as the data layer; server components |
| 2.7 | [Phase 2 capstone — multi-region failover drill](phase-2/07-multi-region-drill.md) | 📋 Drafted | Tabletop + cold drill: lose the primary region, fail over to secondary, measure RTO/RPO across regions; data residency invariants held |

**Pace:** ~9–12 months at part-time. Cumulative with Phase 1 ≈ 18–24 months.

---

## Phase 3 (long-horizon)

- Silo tier productized — per-tenant KMS, dedicated DR, billing tier
- SOC 2 Type II audit prep
- Localization, regional payment rails (Razorpay, PayU, Paystack)
- GraphQL Federation at the BFF layer (only if frontend velocity demands it — ADR-0016 trigger)
- Library / Transport / Health domain services
- Mobile (React Native or native)

---

## Architecture Decision Records

See [`adr/`](adr/) for the running log. **20 ADRs at end of Phase 1**, a "what" + "how" pair per major decision.

| # | Title | Status |
|---|---|---|
| [0001](adr/0001-tenancy-tier-model.md) | Tiered hybrid tenancy model (Pool / Bridge / Silo) | Accepted |
| [0002](adr/0002-monorepo-tooling.md) | Use Nx as the monorepo build tool | Accepted |
| [0003](adr/0003-ci-platform.md) | GitHub Actions for CI | Accepted |
| [0004](adr/0004-prisma-7-setup.md) | Prisma 7 setup with prisma.config.ts and driver adapter | Accepted |
| [0005](adr/0005-rls-tenant-isolation.md) | PostgreSQL RLS with FORCE and SET LOCAL for tenant isolation | Accepted |
| [0006](adr/0006-registry-failure-mode.md) | Tenant registry failure mode is fail-closed | Accepted |
| [0007](adr/0007-control-plane-db-strategy.md) | Control-plane DB is a separate logical DB on the same Postgres cluster (Phase 1) | Accepted |
| [0008](adr/0008-clean-architecture-layering.md) | Clean architecture layering for sis-service (and every domain service after) | Accepted |
| [0009](adr/0009-transactional-outbox-pattern.md) | Transactional outbox for cross-service event publishing | Accepted |
| [0010](adr/0010-listen-notify-transport.md) | Postgres LISTEN/NOTIFY as the Phase 1 event transport | Accepted |
| [0011](adr/0011-saga-orchestration-vs-choreography.md) | Orchestration (not choreography) for the enrollment saga | Accepted |
| [0012](adr/0012-saga-state-storage.md) | Saga state in Postgres (with explicit graduation triggers to Temporal) | Accepted |
| [0013](adr/0013-iam-backbone.md) | Keycloak as the IAM backbone | Accepted |
| [0014](adr/0014-realm-strategy.md) | Single realm with `tenant_id` claim (vs realm-per-tenant) | Accepted |
| [0015](adr/0015-bff-pattern.md) | Backend-for-Frontend per persona (vs shared API) | Accepted |
| [0016](adr/0016-rest-vs-graphql-bff.md) | REST + JSON for BFFs (with explicit GraphQL Federation triggers) | Accepted |
| [0017](adr/0017-otel-collector-architecture.md) | OpenTelemetry Collector as the central observability pipeline | Accepted |
| [0018](adr/0018-slo-and-alerting.md) | SLOs, error budgets, and alerting on symptoms | Accepted |
| [0019](adr/0019-backup-strategy.md) | Backup strategy — pg_dump for Phase 1, pgbackrest at scale | Accepted |
| [0020](adr/0020-dr-tier-targets.md) | DR tier targets — measured, not claimed | Accepted |

---

## Cross-cutting practices

These are not milestones — they are habits to maintain throughout.

- **Conventional commits.** Every commit message follows `feat(scope): subject` so the repo's history is itself a learning artifact.
- **Test-first when the test is cheap to write.** Not religion — judgment. Cross-tenant leakage tests are mandatory; CRUD happy-path tests are optional.
- **One PR per milestone minimum.** Squash-merge to main with a meaningful body. Treat your own PRs as if a reviewer existed; this is the habit you'll carry into senior interviews.
- **Keep `CONTEXT.md` alive.** Every new domain term goes there. A glossary that lags the code is worse than no glossary.
- **The quarterly DR drill is a calendar entry, not an aspiration.** Drill #2 is scheduled for 2026-08-10 (see `postmortems/`); drill #3 follows quarterly.

---

## Reference material

- [Original architecture document](../documentation.md) — the strategic north-star
- [Domain glossary](../CONTEXT.md) — fill this in as you learn the language
- [Phase 1 retrospective template](phase-1/RETROSPECTIVE.md) — write your own summary; the doc is the prompt
- AWS SaaS Lens (Tenant Isolation Strategies whitepaper)
- Microsoft Azure Architecture Center: Multitenant guidance
- Cloudflare Engineering: "Performance isolation in a multi-tenant database environment"
- Nile Database: "Shipping multi-tenant SaaS using Postgres RLS"
- microservices.io (Chris Richardson): saga, outbox, transactional messaging
