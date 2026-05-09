# Phase 1.1 — Tenant context done right

> **Concepts:** PostgreSQL Row-Level Security (RLS), `FORCE ROW LEVEL SECURITY`, GUC + `SET LOCAL`, JWT-derived `tenantId`, transaction-scoped tenant context, the cross-tenant CI test, PgBouncer transaction mode, `SECURITY DEFINER` for RLS recursion
> **Estimated effort:** 2 weekends (the *test* is harder than the *code*)
> **Status:** Not Started
> **Prerequisites:**
> - Milestone 1.0 complete (`/readyz` returns 200, OTel traces visible, kind cluster running)
> - Read [`../../documentation.md`](../../documentation.md) §2.2, §2.3 carefully
> - Skim [Nile blog: *Shipping multi-tenant SaaS using Postgres RLS*](https://www.thenile.dev/blog) for the gotchas section

---

## What you'll learn

- Why application-layer `WHERE tenant_id = ?` filters are unsafe at any scale and what classes of bugs cause leakage in practice.
- The PostgreSQL GUC (Grand Unified Configuration) mechanism — what `current_setting()` returns, how `SET` and `SET LOCAL` differ, and why the difference is a security boundary under PgBouncer transaction mode.
- The complete RLS production pattern: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + permissive vs restrictive policies + a non-owner application role.
- How to derive `tenantId` from a validated JWT claim and **never** from a client header — and the OWASP issue category that comes from getting this wrong.
- The Prisma `$extends` pattern for setting the tenant GUC inside every transaction, and where its sharp edges are (nested transactions, raw SQL escape hatches, background jobs).
- The `SECURITY DEFINER` helper function pattern for breaking RLS recursion on `users` (where the policy must consult the same table to decide if the actor is admin).
- Why the cross-tenant integration test is the most important test in the system and how to write one that cannot be silently broken.

---

## Why this matters (senior perspective)

Every multi-tenant SaaS team eventually loses data the same way: a developer adds a new query in a hurry, forgets the `WHERE tenant_id = ?` clause, and tenant A's data is briefly visible to tenant B. The bug is usually caught by a customer support ticket, not by tests.

The reason this happens reliably — to careful teams, to teams with code review, to teams with linters — is that *defense at the application layer is too late*. By the time the SQL leaves your code, the database has no way to know which tenant you meant. The only durable fix is **isolation enforced at the database**, where the application cannot accidentally bypass it.

PostgreSQL RLS is not a "nice to have" or a "defense in depth" feature in this architecture. **It is the safety net.** When (not if) a developer writes a buggy query, RLS prevents the bug from becoming a breach. The cross-tenant integration test you write in this milestone is the test that fires when the pattern degrades — when someone mocks Prisma and forgets the GUC, when a background job runs without tenant context, when a raw SQL query bypasses the extension.

The senior posture: **assume your future self will make the mistake, and make the mistake non-fatal.**

The PgBouncer interaction is the second senior moment. PgBouncer's transaction mode multiplexes thousands of client connections onto a small pool of server connections. A `SET app.current_tenant_id = 'A'` outside of a transaction sticks to *whichever server connection happened to handle that statement*. The next client to use that connection inherits A's identity. This is exactly the kind of bug that passes every test (because tests don't run under PgBouncer) and explodes in production. The cure is `SET LOCAL` inside an explicit transaction — and verifying it works under transaction-mode pooling before you trust it.

---

## Hands-on plan

### Step 1 — Define the tenant model and the first tenant-scoped table

1. Add a `Tenant` model to your Prisma schema (in the gateway service for now; this will move to the dedicated tenant-service in milestone 1.2). Fields: `id` (uuid), `name`, `tier` (enum: `pool | bridge | silo`), `region`, `createdAt`, `suspendedAt` nullable.
2. Add a tenant-scoped placeholder table — keep `HealthCheck` from milestone 1.0 if you have it, and add `tenantId UUID NOT NULL` to it. Make it a foreign key to `Tenant.id`.
3. Run `prisma migrate dev --name add-tenancy`. Review the generated SQL — you should see the `tenantId` column and the FK.
4. Hand-edit the generated migration (or add a new migration) to include the RLS DDL below. Prisma will not generate RLS for you; this is one of the documented limits.

### Step 2 — Enable RLS the production way

In your migration SQL, for **every** tenant-scoped table:

```sql
-- Mandatory: enable RLS
ALTER TABLE "HealthCheck" ENABLE ROW LEVEL SECURITY;

-- Mandatory: force RLS even for the table owner.
-- Without this, the role that owns the table bypasses policies.
ALTER TABLE "HealthCheck" FORCE ROW LEVEL SECURITY;

-- Permissive policy: rows match when the row's tenant_id equals the GUC.
CREATE POLICY tenant_isolation ON "HealthCheck"
  USING ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);

-- Optional restrictive policy for soft-deletes.
-- Restrictive policies AND with permissive ones — both must pass.
CREATE POLICY active_only ON "HealthCheck" AS RESTRICTIVE
  FOR SELECT USING ("deletedAt" IS NULL);
```

**Why each line:**
- `ENABLE` activates RLS for non-owner roles. Without `FORCE`, the table owner (the role Prisma migrations run as) bypasses everything. This is the single most common RLS misconfiguration in the wild.
- `current_setting('app.current_tenant_id')` reads the GUC. Cast to `uuid` so a missing/invalid GUC fails loudly (`invalid input syntax for type uuid`) rather than silently matching nothing.
- `WITH CHECK` makes the policy bidirectional: not only can you not *read* other tenants' rows, you cannot *write* a row claiming a different tenant_id than your GUC says.
- The restrictive `active_only` policy demonstrates how to compose policies — an attribute that should always apply, regardless of tenant.

### Step 3 — Create a non-owner application role

Migrations run as the migration user (a privileged role). Application traffic must not run as that role.

```sql
CREATE ROLE app_user LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
```

Configure your `DATABASE_URL` in the application to use `app_user`, and a separate `DATABASE_MIGRATION_URL` for the privileged migration role. Two URLs, two responsibilities.

**Why:** application traffic running as the table owner bypasses RLS even with `FORCE` set in some PostgreSQL versions; running as `app_user` removes the ambiguity and makes RLS the only path.

### Step 4 — Set the GUC inside every transaction

Implement a `PrismaService` that wraps every Prisma operation in a transaction with `SET LOCAL` issued first.

The shape of the pattern (you write the actual code):

1. A `ClsService` (from `nestjs-cls`) holds the request-scoped `tenantId`, populated by middleware from the validated JWT.
2. The `PrismaService` extends `PrismaClient` and overrides `$transaction` (or uses `$extends`) so every transaction begins with `SET LOCAL app.current_tenant_id = <value>`.
3. Single-statement reads/writes are routed through an internal helper that opens a transaction, sets the GUC, runs the query, commits.

**Performance note:** opening a transaction per query adds one round-trip. For pooled connections under PgBouncer this is acceptable; if you measure latency regression, consider grouping multiple operations into one explicit `$transaction(async (tx) => { ... })` and setting the GUC once at the start.

**Defensive layer:** add a Prisma middleware that asserts the GUC is set on every operation (read it back via `SELECT current_setting('app.current_tenant_id', true)`, throw if null). This is the runtime equivalent of a unit test — it catches code paths that bypass the extension.

### Step 5 — Wire JWT → CLS

1. Implement a `JwtAuthGuard` that validates the JWT signature (use a hand-rolled symmetric secret for now — milestone 1.6 replaces this with Keycloak).
2. The JWT payload includes `sub` (user id), `tenantId` (uuid), `roles` (array). **Do not** read `tenantId` from a request header. The JWT is the only source of truth.
3. A `TenantContextMiddleware` sets `cls.set('tenantId', request.user.tenantId)` after the guard runs.
4. Add a fail-closed default: if `tenantId` is missing from the JWT for any authenticated route, return 401. The only routes exempt from this check are `/livez`, `/readyz`, and (later) the tenant registry's bootstrap endpoint.

### Step 6 — Background jobs: the tenant-aware processor base class

Even though you don't have BullMQ jobs yet, write the base class now and document its use. The pattern:

- Every job payload **must** carry `tenantId`.
- A `TenantAwareProcessor` base class wraps the user's `process()` method: opens a transaction, sets the GUC, calls `process()` inside.
- A linter rule (or CI grep) enforces that all `@Processor` classes extend `TenantAwareProcessor`.

This won't be exercised until milestone 1.4 (outbox consumers) but the convention must exist before then. Worker code without tenant context is the second-most-common leakage vector.

### Step 7 — The cross-tenant integration test (the most important test in this codebase)

This is the test that, if it ever fails, is treated as a P0 incident. Write it carefully.

The test setup:
1. Spin up a real Postgres (Testcontainers, or the dev Docker Compose with a separate test DB).
2. Run migrations as the migration role.
3. Create two tenants, A and B, via fixtures.
4. Create one `HealthCheck` row for each tenant.
5. Open a Prisma session bound to tenant A. Try every query you can think of: `findMany`, `findUnique` by B's id, `count`, raw SQL, joins. Assert that none returns B's data.
6. Switch to tenant B and reverse.
7. Test the *write* boundary: while in tenant A's context, attempt to `update` B's row by id. Assert that 0 rows are affected (RLS makes the row invisible) or the operation fails.
8. Test missing GUC: open Prisma without setting the GUC. Every query must fail with a recognizable error.

Mark this test with a clear comment block explaining its role. If it ever needs to be modified, that change requires a senior review (which, in your case, is you, sober, with at least one ADR explaining the modification).

### Step 8 — Add PgBouncer in front of Postgres

1. Add a `pgbouncer` service to docker-compose. Configure it in **transaction mode**.
2. Set `default_pool_size = 20`, `max_client_conn = 200`, `auth_query` rather than `auth_file`.
3. Update `DATABASE_URL` to point at PgBouncer (port 6432) instead of directly at Postgres (5432). Add `?pgbouncer=true` to the Prisma connection string — this disables Prisma's prepared statement caching, which interacts badly with transaction-mode pooling.
4. Re-run the cross-tenant test. It must still pass. If `SET LOCAL` were ever silently broken under transaction mode, this test would catch it; verify by hand-rolling a buggy version that uses `SET` instead of `SET LOCAL` and confirming the test catches the leak.

### Step 9 — The `users` table recursion gotcha (read-ahead for milestone 1.6)

Skip implementation, but read about and document it now: when you eventually have a `users` table with an `is_admin` column, an RLS policy that allows admins to bypass tenant scoping creates a recursion (the policy reads the same table the policy guards). The cure is a `SECURITY DEFINER` helper function that performs the lookup with elevated privilege. Note this in your ADR archive so milestone 1.6 doesn't surprise you.

### Step 10 — Write the ADR

[`adr/0004-rls-tenant-isolation.md`](../adr/) (or whatever your next number is) — defending RLS + `SET LOCAL` over alternatives (app-layer filters, schema-per-tenant, Postgres roles per tenant). Use the ADR template; the alternatives section is where the value lies.

---

## Definition of done

- [ ] Every tenant-scoped table has `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and a `tenant_isolation` policy.
- [ ] Application connects as `app_user`, not as the table owner.
- [ ] `PrismaService` issues `SET LOCAL app.current_tenant_id` at the start of every transaction.
- [ ] Defensive middleware asserts the GUC is set; throws if absent.
- [ ] `TenantContextMiddleware` populates CLS from the validated JWT only — never from headers.
- [ ] `TenantAwareProcessor` base class exists and is documented (even if no jobs use it yet).
- [ ] Cross-tenant integration test exists, runs in CI, fails closed if cross-tenant data is ever returned.
- [ ] PgBouncer in transaction mode in front of Postgres; `pgbouncer=true` in connection string; tests still pass.
- [ ] You have manually broken the GUC pattern (e.g., changed `SET LOCAL` to `SET`) and confirmed the cross-tenant test catches the regression. Then reverted.
- [ ] ADR-0004 (or equivalent) written defending RLS + `SET LOCAL`.

---

## Common pitfalls

1. **Using `SET` instead of `SET LOCAL`.** Outside an explicit transaction, `SET` persists for the lifetime of the server connection. Under PgBouncer transaction mode, that connection serves a different client next. **The single most dangerous bug in this pattern.**
2. **Migrating with the application role.** The role that creates the table is the table owner; without `FORCE ROW LEVEL SECURITY`, the owner bypasses policies. Use a separate migration role and set `FORCE` always.
3. **Trusting `tenantId` from a request header.** OWASP A01 (Broken Access Control). The JWT signature is the only authority.
4. **Writing the cross-tenant test against an in-memory DB or a mock.** RLS is a Postgres feature; testing against anything else proves nothing. Use Testcontainers or an actual Postgres.
5. **Forgetting the `WITH CHECK` clause.** Without it, a tenant could `INSERT` a row with another tenant's `tenant_id`. The asymmetry is subtle and easy to miss.
6. **Relying on Prisma's `$transaction` without `$extends` or middleware.** Prisma does not know about the GUC; you must wire it explicitly.
7. **Background jobs without tenant context.** A worker pulling from BullMQ without setting the GUC reads from no tenant — which under RLS returns zero rows, which often looks like "no work to do" rather than an error. Silent failure mode.
8. **Forgetting `?pgbouncer=true` on the Prisma URL.** Symptom: random `prepared statement does not exist` errors at moderate concurrency.
9. **Casting the GUC to `text` instead of `uuid`.** A bare string comparison fails open if the GUC is empty (`'' = ''` is true). The `::uuid` cast forces a parse error on missing GUC.
10. **Disabling the cross-tenant test "temporarily" to ship.** If you can't pass it, you have a leakage. Fix the leak; never the test.

---

## Stretch goals (optional rabbit holes)

- **Replace `nestjs-cls` with raw `AsyncLocalStorage`** to understand the primitive. It's ~30 lines of code; the wrapper hides what's happening.
- **Implement `SECURITY DEFINER` for an `is_admin` lookup** even before the IAM milestone. Build a toy users table, write the recursive policy, see it fail, fix it with a definer function.
- **Add a Postgres `pgaudit` extension** and capture every query the app role runs. Verify the GUC value is visible in the audit log.
- **Try schema-based sharding (Citus 12+) on a branch** to feel why the doc recommends row-based RLS instead. Compare migration ergonomics, isolation guarantees, and operational shape.
- **Build a "tenant impersonation" admin endpoint** (gated by an admin role from the JWT) that lets a support engineer act as a specific tenant. Note how the audit log changes — `actor_id` and `tenant_id` differ.
- **Write a fuzz test** that generates random Prisma queries and asserts cross-tenant data never appears. Property-based testing for security invariants.
- **Run a `pgbench` workload through PgBouncer with the GUC pattern** and measure the per-query latency overhead vs without `SET LOCAL`. You should see ~0.1–0.3ms; if it's higher, your network is the bottleneck.

---

## Reflection questions

1. **Why is application-layer `WHERE tenant_id = ?` filtering insufficient?** Describe one concrete scenario from your own code in milestone 1.0 where you might have forgotten the clause if RLS weren't there.
2. **What is the difference between `SET` and `SET LOCAL`?** Explain it as if to a junior engineer who has never seen PgBouncer.
3. **Why does `FORCE ROW LEVEL SECURITY` exist as a separate clause from `ENABLE`?** What pre-`FORCE` assumption would have made the unforced version "good enough"?
4. **Cast `current_setting()` to `uuid`. What happens if the GUC is unset and you cast to `text` instead?** Why is this a security distinction, not just a correctness one?
5. **Background workers and tenant context: in your design, where does `tenantId` enter the system, and how does it travel to a worker that runs an hour later?**
6. **The cross-tenant test passed. What kind of bugs would it still miss?** (Hint: anything the test doesn't query for.)
7. **You manually broke the GUC pattern in step 8. How long did the regression take to discover? In production, with no test, how long might it have taken?**

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §2.2 (RLS production pattern), §2.3 (NestJS implementation), §2.4 (Connection pool math).
- **PostgreSQL docs:** *Row Security Policies* (`postgresql.org/docs/current/ddl-rowsecurity.html`). Read in full at least once.
- **Nile blog:** *Shipping multi-tenant SaaS using Postgres RLS* — production gotchas including `SECURITY DEFINER`.
- **AWS Database Blog:** *Multi-tenant data isolation with PostgreSQL Row Level Security*.
- **Cloudflare Engineering:** *Performance isolation in a multi-tenant database environment* — adaptive throttling at PgBouncer.
- **Microsoft Azure docs:** *Multi-tenant SaaS database tenancy patterns*.
- **OWASP API Security Top 10:** A01 *Broken Object Level Authorization* — the failure mode you're preventing.

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.1 to `Done`. Move to milestone 1.2 (Tenant registry as control plane). The single-tenant assumption you've been carrying ends there.
