# ADR-0007: Control-plane database is a separate logical DB on the same Postgres cluster (Phase 1)

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

[ADR-0001](0001-tenancy-tier-model.md) established the control-plane / data-plane
split: the registry of tenants lives in its own DB, separate from any tenant's
data. Milestone 1.2 had to decide *how separate* — same database different
schema, separate database same cluster, separate cluster, or separate
PostgreSQL instance entirely.

The choice trades isolation strength against operational cost. At Phase 1
(one engineer, one region, ~tens of test tenants) we don't have the burden
budget for multiple Postgres instances. At Phase 3 (regulated customers,
multi-region, thousands of tenants) we likely do. This ADR locks in the
Phase 1 answer with explicit triggers for promotion in later phases.

## Decision

**The control plane is a separate logical database (`sms_control`) on the
same Postgres cluster as the data plane (`sms_dev`).**

- Both databases live in the local compose Postgres container.
- `tenant-service` connects via `CONTROL_PLANE_DATABASE_URL` (logical DB
  `sms_control`); gateway uses `DATABASE_URL` (logical DB `sms_dev`).
- The two share the same Postgres role hierarchy (`sms_app` / `app_user`),
  PgBouncer pool, and backup window.
- An init script ([`infra/postgres/initdb/01-create-control-plane-db.sh`](../../infra/postgres/initdb/01-create-control-plane-db.sh))
  creates `sms_control` on first Postgres bootstrap.

Phase 2 promotes to a separate Postgres cluster when one of the triggers
below fires (see Consequences).

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Same DB, different schema** | Cheapest; one connection pool; one backup | NO blast-radius isolation — a runaway query on data plane still impacts control plane; a bad migration on either schema affects the same `pg_catalog` | Defeats the entire point of having a separate registry. The whole reason the registry exists is to be unaffected by data-plane health |
| **Same cluster, different DB (chosen)** | Cheap operations (one Postgres, one PgBouncer, one backup); independent migrations; per-DB role grants; trivial to promote later | Some shared blast radius (cluster CPU saturation hits both); shared OS-level resource limits | n/a — the right fit for Phase 1 |
| **Separate cluster (Phase 3)** | True blast-radius isolation; independent scaling; per-cluster maintenance windows | Twice the operations: two PgBouncers, two backup pipelines, two upgrade paths, two monitoring dashboards | Right answer, wrong phase. Premature at one engineer + tens of tenants |
| **Separate Postgres on a different host** | All of the above + physical fault isolation | Above + cross-AZ networking cost + more failure modes (network partition between control and data planes) | Phase 3 territory at the earliest |

## Consequences

**Positive:**

- One compose stack — `docker compose up` brings up everything.
- One `pg_dump` strategy covers both DBs.
- Migrations isolated: gateway's `apps/gateway/prisma/migrations` and
  tenant-service's `apps/tenant-service/prisma/migrations` evolve
  independently.
- Postgres roles isolate access: `app_user` has no privileges on `sms_control`
  by default; gateway code that touches the registry MUST go through the
  HTTP layer (`@org/tenant-registry`).
- Easy to promote: changing `CONTROL_PLANE_DATABASE_URL` from
  `localhost:5433/sms_control` to `<other-host>:5432/sms_control` requires
  no code change.

**Negative / costs:**

- Cluster-wide outages take down both planes. A "tenant-service is down,
  let me query the registry to triage" workflow doesn't help if Postgres
  itself is the problem.
- Shared `max_connections`. PgBouncer pooling mitigates but doesn't eliminate
  the contention.
- Operators have to remember which DB to `\c` into when poking around — a
  small but recurring papercut.
- Foreign-key references across DBs are impossible (Postgres FKs are
  intra-database only). `health_check.tenantId` in `sms_dev` is a "logical"
  reference to `tenant.id` in `sms_control` — validated by the registry
  client at runtime, not by the database. Documented in
  [the drop_tenant_table migration](../../apps/gateway/prisma/migrations/20260510021735_drop_tenant_table/migration.sql).

**Risks:**

- Future engineer adds a `JOIN` against `tenant` from a tenant-scoped table,
  expecting the FK to be there. Mitigation: the migration's comment block
  flags this; CONTEXT.md repeats the lesson; future ESLint rule (Phase 2)
  could lint against cross-DB joins.
- A bad migration in tenant-service that takes Postgres down (e.g., a
  rewrite of a giant table holding a lock) takes the data plane down too.
  Mitigation: keep the registry tables small (they should never need
  long-running DDL) + standard pre-deploy migration review.

**Follow-up work this enables / forces:**

- **Phase 2 promotion triggers.** Move `sms_control` to a separate Postgres
  cluster when ANY of the following is true:
  1. The control plane needs a different SLO than the data plane (e.g., 99.99%
     vs 99.9%) — see [ADR-0006](0006-registry-failure-mode.md).
  2. A regulated customer requires the registry to live in a specific region/jurisdiction.
  3. Cluster-wide CPU/IOPS contention from the data plane impacts registry latency.
  4. We need to take the data plane offline for maintenance without
     affecting registry reads (or vice versa).
- **Phase 3 multi-region.** Each region gets its own data-plane cluster +
  its own regional control-plane replica. Active-active control plane
  via logical replication or commercial alternatives (Aurora Global,
  CockroachDB, pgEdge). This is years away; flag.
- **Backup retention parity.** Both DBs in the same cluster share the
  WAL stream. When milestone 1.9 introduces the DR drill, the restore
  procedure restores BOTH databases from the same point in time —
  registry and data come back consistent.

## References

- Init script: [`infra/postgres/initdb/01-create-control-plane-db.sh`](../../infra/postgres/initdb/01-create-control-plane-db.sh)
- Compose config: [`infra/docker-compose.yml`](../../infra/docker-compose.yml)
- Env vars: `CONTROL_PLANE_DATABASE_URL`, `CONTROL_PLANE_MIGRATION_URL` in [`.env.example`](../../.env.example)
- Phase 1.2 milestone: [`../phase-1/02-tenant-registry.md`](../phase-1/02-tenant-registry.md), §2.1
- Related: [ADR-0001](0001-tenancy-tier-model.md), [ADR-0006](0006-registry-failure-mode.md)
