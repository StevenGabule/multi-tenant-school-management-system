# Architecture Decision Records

An ADR (Architecture Decision Record) captures **one** non-trivial technical decision: the context that forced it, the choice made, and what changes as a consequence. ADRs are written *as* you decide, not retroactively, and are never edited after acceptance — superseded decisions get a *new* ADR that supersedes the old one.

> The ADR practice is the single highest-leverage habit you can build during this project. Senior engineers leave a trail of *why*. Mid-level engineers leave only the *what*.

---

## When to write an ADR

Write an ADR when **all** of these are true:

1. The decision affects more than one file or one component.
2. A reasonable engineer could plausibly have chosen the other option.
3. Reversing the decision later would be expensive (hours, not minutes).

Examples that warrant an ADR:
- Tenancy model (Pool / Bridge / Silo)
- Choice of message bus (Postgres LISTEN/NOTIFY vs Kafka vs RabbitMQ)
- ORM strategy (Prisma vs raw SQL vs TypeORM)
- Auth backbone (Keycloak vs Auth0 vs DIY)
- Event consistency model (outbox vs dual-write vs CDC)

Examples that do **not** warrant an ADR:
- Naming a function
- Adding a logging line
- Choosing between `npm` and `pnpm` (unless this drives monorepo tooling)

If you're unsure, write the ADR. Discarded ADRs cost a few minutes; missing ADRs cost months of "why did we do it this way?"

---

## Format

Each ADR is one Markdown file: `NNNN-kebab-case-title.md`, where `NNNN` is a zero-padded sequence number. Number monotonically — never reuse.

```markdown
# ADR-NNNN: <Decision title>

> **Status:** Proposed | Accepted | Superseded by ADR-XXXX | Deprecated
> **Date:** YYYY-MM-DD
> **Deciders:** <names or "self">

## Context

What problem are we solving? What forces are at play (technical, business, political)? What constraints exist? Plain prose, 2–6 paragraphs. The reader should understand WHY a decision was needed, even a year from now.

## Decision

Stated as a complete sentence in active voice.

> "We will use PostgreSQL Row-Level Security with a transaction-scoped GUC for tenant isolation in the pool tier."

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| A: ... | ... | ... | ... |
| B: ... | ... | ... | ... |
| C (chosen): ... | ... | ... | n/a |

## Consequences

What changes as a result?

- **Positive:** ...
- **Negative / costs:** ...
- **Risks:** ...
- **Follow-up work this enables/forces:** ...

## References

- Link to relevant docs, blog posts, mailing list threads
- Link to any prototype/spike that informed the decision
```

---

## Lifecycle states

- **Proposed:** Drafted but not yet committed to. Use sparingly — most ADRs should be accepted at write-time.
- **Accepted:** Decision is in force. **Never edit an Accepted ADR's body**, except to add references or clarify ambiguous wording. If the decision changes, write a new ADR that supersedes it.
- **Superseded:** Replaced by ADR-XXXX. The body stays as a historical record.
- **Deprecated:** No longer applies (e.g., the system was removed) but no replacement exists.

The "never edit accepted" rule is the most violated and the most important. The historical record loses meaning the moment it can be revised.

---

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-tenancy-tier-model.md) | Tiered hybrid tenancy model | Accepted |
| [0002](0002-monorepo-tooling.md) | Use Nx as the monorepo build tool | Accepted |
| [0003](0003-ci-platform.md) | GitHub Actions for CI | Accepted |
| [0004](0004-prisma-7-setup.md) | Prisma 7 setup with prisma.config.ts and driver adapter | Accepted |
| [0005](0005-rls-tenant-isolation.md) | PostgreSQL RLS with FORCE and SET LOCAL for tenant isolation | Accepted |
| [0006](0006-registry-failure-mode.md) | Tenant registry failure mode is fail-closed | Accepted |
| [0007](0007-control-plane-db-strategy.md) | Control-plane DB is a separate logical DB on the same Postgres cluster (Phase 1) | Accepted |
| [0008](0008-clean-architecture-layering.md) | Clean architecture layering for sis-service (and every domain service after) | Accepted |
| [0009](0009-transactional-outbox-pattern.md) | Transactional outbox for cross-service event publishing | Accepted |
| [0010](0010-listen-notify-transport.md) | Postgres LISTEN/NOTIFY as the Phase 1 event transport | Accepted |
| [0011](0011-saga-orchestration-vs-choreography.md) | Orchestration (not choreography) for the enrollment saga | Accepted |
| [0012](0012-saga-state-storage.md) | Saga state in Postgres (with explicit graduation triggers to Temporal) | Accepted |
| [0013](0013-iam-backbone.md) | Keycloak as the IAM backbone | Accepted |
| [0014](0014-realm-strategy.md) | Single realm with `tenant_id` claim (vs realm-per-tenant) | Accepted |
| [0015](0015-bff-pattern.md) | Backend-for-Frontend per persona (vs shared API) | Accepted |
| [0016](0016-rest-vs-graphql-bff.md) | REST + JSON for BFFs (with explicit GraphQL Federation triggers) | Accepted |

---

## Further reading

- Michael Nygard's original 2011 post: *Documenting Architecture Decisions*
- ThoughtWorks Technology Radar entry on Lightweight ADRs
- `adr-tools` (Nat Pryce) — CLI for managing ADRs; optional, the format is what matters, not the tool
