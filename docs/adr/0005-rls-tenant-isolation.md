# ADR-0005: PostgreSQL RLS with FORCE and SET LOCAL for tenant isolation

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

The pool tier from [ADR-0001](0001-tenancy-tier-model.md) puts every standard
tenant's data in the same PostgreSQL cluster, in shared tables. Cross-tenant
isolation is a contractual obligation and a security floor — a pool-tier
tenant must NEVER see another's rows, regardless of bugs in application
code.

Three mitigation strategies exist. This ADR settles which we adopt and why.

The choice has wide blast radius: it dictates how every service constructs
its database session, what role the application connects as, where DDL
lives, and what the most important integration test in the repo looks like.

## Decision

**We will enforce tenant isolation with PostgreSQL Row-Level Security**
using these specific elements:

1. **Every tenant-scoped table** carries `tenantId UUID NOT NULL` with a
   foreign key to `tenant(id)` and an index on `(tenantId)`.

2. **`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`** on every
   tenant-scoped table. FORCE is non-negotiable: without it, the role that
   owns the table bypasses RLS — the most common production breach pattern.

3. **The `tenant_isolation` policy** uses `app.current_tenant_id` (a
   custom GUC) as the predicate, with a strict cast:
   ```sql
   USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
   WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid)
   ```
   - The `::uuid` cast forces a loud error when the GUC is missing
     (`unrecognized configuration parameter`), instead of silently
     matching `'' = ''` and returning zero rows.
   - `WITH CHECK` makes the policy bidirectional: a session bound to
     tenant A cannot insert a row claiming tenant B's id.

4. **A non-owner application role (`app_user`)** for runtime traffic.
   Created with `CREATE ROLE app_user LOGIN`, granted only data ops
   (SELECT/INSERT/UPDATE/DELETE), and explicitly NOT a superuser and NOT
   `BYPASSRLS`. Migrations run as `sms_app` (the privileged role) via a
   separate `DATABASE_MIGRATION_URL`.

5. **`SET LOCAL` (never `SET`)** to bind the GUC inside an explicit
   transaction. Verified empirically: under PgBouncer transaction-mode
   pooling, `SET` (without LOCAL) leaks across pooled connections —
   conn1 sets a value, conn2 reads it back. `SET LOCAL` evaporates on
   COMMIT and is the only safe form.

6. **A `PrismaService.withTenant(tenantId, fn)` helper** that opens a
   transaction, issues `SET LOCAL app.current_tenant_id = '...'`, runs
   the callback inside, and commits. Its companion `withCurrentTenant`
   reads tenantId from CLS (set by `JwtAuthGuard`) so route handlers
   don't have to thread it.

7. **The cross-tenant integration test** spins up a fresh Postgres via
   Testcontainers, applies all migrations, then runs 11 assertions as
   `app_user`. If any assertion fails, the multi-tenant guarantee is
   broken at the database level.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **App-layer `WHERE tenant_id = ?` filters** | No DB feature dependency; simple to start | Forgotten clause = breach; no defence against background jobs missing tenant context; impossible to audit with confidence | Every team that tries this loses data eventually |
| **Schema-per-tenant** | Strong logical isolation; per-schema dump/restore; legible to procurement | Hard wall at ~5–10k schemas (`pg_catalog` cost); PgBouncer struggles with `search_path`; Prisma migration complexity multiplies | Reserved for Bridge tier as a *transient* migration step (ADR-0001) |
| **DB-per-tenant (Silo)** | Strongest isolation; per-tenant backup; per-tenant tuning | Cost-prohibitive at the long tail; per-tenant migrations are an operational treadmill | Reserved for Silo tier (ADR-0001) — premium / regulated customers only |
| **RLS + GUC + FORCE (chosen)** | DB-level enforcement that bugs can't bypass; one schema to migrate; works for the long tail; defence in depth alongside app checks | Six places carry coupled knowledge (PrismaService, migrations, app role, PgBouncer, tests, ADR); SET vs SET LOCAL is a sharp edge | n/a |

## Consequences

**Positive:**

- A bug that drops tenant context (forgotten `withTenant`, a worker that
  bypassed `TenantAwareProcessor`, raw SQL with bad interpolation) cannot
  cause a leak — RLS rejects it at the database. Defence in depth is real.
- The integration test demonstrably catches policy regressions: deliberately
  changing `USING ("tenantId" = ...)` to `USING (true)` failed 7 of 11
  cross-tenant tests in step 9. Verified in the milestone, not theory.
- Same pattern scales as more services come online — every tenant-scoped
  table in milestones 1.3+ inherits this contract.
- `withCurrentTenant` keeps service code clean: handlers don't thread
  `tenantId` through every call. CLS + the JWT guard supply it.

**Negative / costs:**

- A per-query overhead: every Prisma operation that needs tenant scope
  opens a transaction. Measurable but small; acceptable for the safety.
- Two database URLs in env (`DATABASE_URL`, `DATABASE_MIGRATION_URL`).
  Misconfiguring either is a debugging puzzle.
- Application code that touches the `tenant` table itself uses the raw
  Prisma client (no `withTenant`), because `tenant` is the registry — NOT
  itself RLS-scoped. This split is documented in CONTEXT.md but is a
  recurring "wait, why doesn't this need wrapping?" question.
- `RESTRICTIVE FOR SELECT` policies surprised us: Postgres also evaluates
  them against new rows produced by INSERT/UPDATE (to prevent commands
  that produce invisible-to-author rows). This makes naive
  soft-delete-via-UPDATE impossible while `active_only` exists. Real
  soft-delete needs either a `SECURITY DEFINER` bypass or moves to
  application-layer `WHERE deletedAt IS NULL` filtering. Pinned by the
  test; documented in the test's comment block.

**Risks:**

- **`SET` without LOCAL** under PgBouncer transaction mode silently
  multiplexes a tenant's GUC onto whichever client lands on that server
  connection next. We verified the leak with a deliberate test in
  milestone 1.1 step 7. Mitigation: code review + the integration test
  + ESLint rule (post-1.3) banning bare `SET app.*` outside `SET LOCAL`.
- **`BYPASSRLS` accidentally granted** to `app_user` (or `app_user`
  becoming a superuser) defeats every policy. Mitigation: the
  `app_user_role` migration's belt-and-suspenders DO block fails the
  migration if either attribute is true.
- **The recursive RLS gotcha on the future `users` table** (where the
  policy needs to consult the same table to decide if the actor is admin)
  is documented now but not implemented. Milestone 1.6 (IAM) introduces
  the `SECURITY DEFINER` helper function pattern.

**Follow-up work this enables / forces:**

- Milestone 1.2 (tenant registry) inherits this pattern: every new
  tenant-scoped table goes through `prisma migrate dev --create-only` →
  manual append of RLS DDL → apply.
- Milestone 1.3 (SIS) adds the first real domain models with the same
  contract: `tenantId NOT NULL`, FORCE + ENABLE RLS, `tenant_isolation`
  policy.
- Milestone 1.4 (outbox + workers) exercises `TenantAwareProcessor` for
  real — every job pulls tenantId off the payload and goes through
  `withTenant`.
- Milestone 1.6 (Keycloak) replaces the hand-rolled JWT but the guard's
  job stays the same: validate signature, push tenantId into CLS.

## References

- Project docs: [`../phase-1/01-tenant-context.md`](../phase-1/01-tenant-context.md)
- PostgreSQL docs: [Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- Nile blog: *Shipping multi-tenant SaaS using Postgres RLS* (production gotchas)
- AWS Database Blog: *Multi-tenant data isolation with PostgreSQL Row Level Security*
- Cloudflare Engineering: *Performance isolation in a multi-tenant database environment*
- This repo: `apps/gateway/prisma/migrations/20260510013135_add_tenancy/migration.sql`
- This repo: `apps/gateway/prisma/migrations/20260510013416_app_user_role/migration.sql`
- This repo: `apps/gateway/src/prisma/prisma.service.ts` (withTenant)
- This repo: `apps/gateway/src/prisma/cross-tenant.integration.spec.ts` (the safety net)
