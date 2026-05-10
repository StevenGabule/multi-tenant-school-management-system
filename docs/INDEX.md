# Multi-Tenant SMS — Learning Roadmap

A learning-frame Phase 1 for a multi-tenant school management system. The goal is **not** to ship a product; the goal is to develop senior-level technical depth across distributed systems, multi-tenancy, and production engineering by building the smallest viable system that exercises every load-bearing pattern at least once.

> If you wanted to ship fast, you would build less. You are building this to learn deep — the pattern coverage is the curriculum, not the feature surface.

---

## How to use this roadmap

1. **Each milestone is a stop, not a sprint.** Stay until the concept is yours. Re-read your own ADR a week later — if it doesn't make sense, you didn't learn it yet.
2. **Honor the Definition of Done.** It's the interview question you couldn't bluff. If you can't tick every box, the milestone isn't done.
3. **Write an ADR for any non-default choice.** See [`adr/README.md`](adr/README.md). Three ADRs by end of Phase 1 is a floor, not a ceiling.
4. **Update the status column below as you progress.** Treat it as a public commitment.
5. **Never skip the reflection questions.** The fastest route from mid-level to senior is forcing yourself to articulate tradeoffs in your own words.

---

## Phase 1 milestones

| # | Milestone | Status | Key concepts |
|---|---|---|---|
| 1.0 | [Foundations & walking skeleton](phase-1/00-foundations.md) | Not Started | Nx monorepo, NestJS, Prisma, Docker Compose, Kubernetes (kind), OTel, CI |
| 1.1 | [Tenant context done right](phase-1/01-tenant-context.md) | Not Started | RLS, `FORCE ROW LEVEL SECURITY`, GUC + `SET LOCAL`, JWT-derived `tenantId`, cross-tenant CI test |
| 1.2 | [Tenant registry as control plane](phase-1/02-tenant-registry.md) | Not Started | Two-database model (control plane vs tenant data), registry caching, region/tier metadata |
| 1.3 | [First domain service: SIS](phase-1/03-sis-first-service.md) | Not Started | Repository pattern, clean architecture layering, DTO validation, soft-delete under RLS |
| 1.4 | [Outbox + event consumer](phase-1/04-outbox-events.md) | Not Started | Transactional outbox, idempotency, ordering — start with Postgres `LISTEN/NOTIFY`, graduate to Kafka in stretch |
| 1.5 | [First saga: Enrollment](phase-1/05-enrollment-saga.md) | Not Started | Orchestrated saga, compensations, durable state machine |
| 1.6 | [IAM with Keycloak](phase-1/06-iam-keycloak.md) | Not Started | OIDC flow, JWT validation, RBAC + ABAC ("parent of student X"), refresh tokens, optional MFA |
| 1.7 | [BFF as JSON aggregator](phase-1/07-bff-aggregator.md) | Not Started | BFF pattern, contract testing, over-fetching/latency stacking — backend-only, no frontend |
| 1.8 | [Observability that earns its keep](phase-1/08-observability.md) | Not Started | OTel `tenant_id` baggage, Tempo + Prometheus + Loki + Grafana, one operational dashboard |
| 1.9 | [DR drill](phase-1/09-dr-drill.md) | Not Started | Backup, restore to sandbox, measured (not claimed) RPO/RTO |

**Pace:** ~6–9 months at part-time. Anchor on milestones, not weeks.

---

## Phase 2 (after Phase 1 is fully done — not before)

- Multi-region deployment & data residency enforcement
- Citus introduction; tenant promotion (pool → silo) automation
- Service mesh (Istio or Linkerd) for mTLS, retries, canary
- Event sourcing for attendance, discipline, gradebook history
- More services: Fees/Payments, Library, Transport, Health
- Frontend (Next.js or alternative) — first real client app

## Phase 3 (long-horizon)

- Silo tier productized — per-tenant KMS, dedicated DR
- SOC 2 Type II audit prep
- Localization, regional payment rails (Razorpay, PayU, Paystack)
- GraphQL Federation at the BFF layer (only if frontend velocity demands it)

---

## Architecture Decision Records

See [`adr/`](adr/) for the running log of decisions and their rationale.

| # | Title | Status |
|---|---|---|
| [0001](adr/0001-tenancy-tier-model.md) | Tiered hybrid tenancy model (Pool / Bridge / Silo) | Accepted |
| [0002](adr/0002-monorepo-tooling.md) | Use Nx as the monorepo build tool | Accepted |
| [0003](adr/0003-ci-platform.md) | GitHub Actions for CI | Accepted |
| [0004](adr/0004-prisma-7-setup.md) | Prisma 7 setup with prisma.config.ts and driver adapter | Accepted |

---

## Cross-cutting practices

These are not milestones — they are habits to maintain throughout.

- **Conventional commits.** Every commit message follows `feat(scope): subject` so the repo's history is itself a learning artifact.
- **Test-first when the test is cheap to write.** Not religion — judgment. Cross-tenant leakage tests are mandatory; CRUD happy-path tests are optional.
- **One PR per milestone minimum.** Squash-merge to main with a meaningful body. Treat your own PRs as if a reviewer existed; this is the habit you'll carry into senior interviews.
- **Keep `CONTEXT.md` alive.** Every new domain term goes there. A glossary that lags the code is worse than no glossary.

---

## Reference material

- [Original architecture document](../documentation.md) — the strategic north-star
- [Domain glossary](../CONTEXT.md) — fill this in as you learn the language
- AWS SaaS Lens (Tenant Isolation Strategies whitepaper)
- Microsoft Azure Architecture Center: Multitenant guidance
- Cloudflare Engineering: "Performance isolation in a multi-tenant database environment"
- Nile Database: "Shipping multi-tenant SaaS using Postgres RLS"
- microservices.io (Chris Richardson): saga, outbox, transactional messaging
