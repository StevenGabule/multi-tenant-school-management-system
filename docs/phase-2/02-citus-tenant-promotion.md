# Phase 2.2 — Citus + tenant promotion (pool → silo)

> **Concepts:** Citus distributed Postgres, shard keys, the pool/bridge/silo migration, online tenant moves, dual-write windows, the saga for "promote tenant X to its own cluster"
> **Estimated effort:** 4 weekends — the productization of ADR-0001's tier model
> **Status:** Not Started
> **Prerequisites:**
> - Milestone 2.1 complete (multi-region is the operational floor for tenant moves)
> - Re-read ADR-0001 (tenancy tier model) and ADR-0007 (control-plane DB)

---

## What you'll learn

- **Citus** as a distributed Postgres extension: coordinator + workers, distributed tables, reference tables, the shard-key contract.
- **Tenant promotion**: moving a single tenant from the shared pool cluster to its own silo cluster, with zero downtime. The saga that orchestrates the move.
- **Dual-write windows**: during migration, writes go to both the source and destination. The cutover is the moment dual-write stops + the destination becomes canonical.
- **Online vs offline schema changes** at scale: ALTER TABLE on a 100GB table; `pg_repack`; logical replication for the brave.
- **The reverse — demotion**: moving a silo tenant back to the pool (cost saver). Same saga, reverse direction.

---

## Why this matters (senior perspective)

ADR-0001 committed to the tiered model (pool / bridge / silo) but Phase 1 only built the pool tier. Tenant promotion is the operational lever that converts the tier model from a slide into a product feature: "upgrade to enterprise tier — you get your own database with stricter SLAs." Without the migration tooling, the tier model is fiction.

The senior posture has three parts:

1. **The migration is a saga, not a script.** A tenant move that fails mid-way must compensate cleanly — leaving the source intact, destination empty. The Phase 1.5 enrollment saga taught the pattern; this is the harder application.
2. **Zero downtime is a discipline, not a marketing claim.** It means dual-write windows, careful cutover, planned rollback. Customers who got promoted on Tuesday and saw 30 seconds of errors at the cutover are unhappy customers.
3. **Citus is one of several answers.** Phase 2 picks Citus for the distributed-pool path; ADR-0025 will document the alternatives (Yugabyte, CockroachDB, sharded-by-app) and the conditions under which we'd flip.

---

## Hands-on plan

### Step 1 — Stand up Citus

For local learning, Citus's docker-compose example provides a 3-node cluster (coordinator + 2 workers). Replace the milestone-1.x shared `sms_sis` Postgres for one tenant-data DB with Citus.

The other DBs (sms_control, sms_academic, sms_enrollment) STAY on regular Postgres for now — Phase 2 introduces Citus where the scaling pressure is, not everywhere.

### Step 2 — Convert tables to distributed

```sql
-- Distribute the student table by tenantId — every tenant's rows
-- live on one shard.
SELECT create_distributed_table('student', 'tenantId');
SELECT create_distributed_table('guardian', 'tenantId');
SELECT create_distributed_table('guardian_link', 'tenantId');
SELECT create_distributed_table('outbox_event', 'tenantId');
SELECT create_distributed_table('processed_request', 'tenantId');
```

Reference tables (small, lookup-y) stay non-distributed:
```sql
SELECT create_reference_table('country');  -- example
```

Every tenant-scoped query MUST include `tenantId` in its WHERE clause for shard pruning. Without it, Citus broadcasts to all workers — fine for correctness, awful for performance.

### Step 3 — Cross-tenant test still passes

Citus + RLS interaction: the RLS policies set up in milestone 1.1 must still enforce tenant_isolation. Citus respects RLS on each shard. The cross-tenant test from milestone 1.1 (a tenant-A token cannot read tenant-B's rows) must still pass — RUN IT.

### Step 4 — Tenant promotion saga

The saga that moves a tenant from the shared Citus pool to a dedicated single-node Postgres cluster (the silo):

```typescript
const TenantPromotionSaga: SagaDefinition = [
  { name: 'provision-silo', execute: provisionSiloCluster, compensate: deprovisionSiloCluster },
  { name: 'create-tenant-kek', execute: createTenantKek, compensate: shredKek },
  { name: 'enable-dual-write', execute: enableDualWriteAtBff, compensate: disableDualWrite },
  { name: 'copy-tenant-rows', execute: copyTenantRowsToSilo, compensate: truncateSiloRows },
  { name: 'verify-row-counts', execute: verifyParity, compensate: noop },
  { name: 'update-registry', execute: setTenantToSilo, compensate: setTenantToPool },
  { name: 'disable-dual-write', execute: disableDualWrite, compensate: enableDualWrite },
  { name: 'delete-from-pool', execute: deletePoolRows, compensate: noop /* one-way */ },
];
```

The last step is one-way — by the time we delete from the pool, the registry has flipped and the source of truth IS the silo. Mid-saga failures before that step are fully reversible.

### Step 5 — Dual-write at the BFF

During the saga's dual-write window, every write to a promoted tenant's data goes to BOTH the pool and the silo. The application has to know "this tenant is mid-promotion." Two patterns:

- **Registry flag**: tenant.status = 'promoting'. The BFF / services check it and fan out the write.
- **Migration coordinator**: a separate service holds the dual-write registry and the saga reads it.

For Phase 2: registry flag, simpler.

### Step 6 — The cutover

The cutover is a single registry update. Before: `tenant.tier=pool`. After: `tenant.tier=silo, tenant.cluster_id=<silo-uuid>`. The transition is atomic at the registry.

Downstream services consult the registry on every request (cached, with invalidation — milestone 1.2's pattern). The cache invalidation fires across services via Redis pub/sub when the registry update commits. The cutover is "the cache update propagates," which is sub-second.

### Step 7 — Tenant demotion (reverse direction)

Same saga, reverse direction. A tenant whose usage dropped below the silo tier's economics gets demoted back to pool. The saga's steps invert; the patterns hold.

Documented because the reverse case is what makes the tier model honest — promotion isn't permanent.

### Step 8 — Tests

- **Promotion happy path**: a pool tenant is promoted to silo; all data is in the silo cluster; no data remains in the pool; the BFF reads transparent.
- **Mid-saga failure**: kill the saga at each step; verify compensation leaves the tenant in a coherent state (still in pool, no silo cluster, no orphan registry rows).
- **Concurrent writes during dual-write**: 100 writes/sec to the tenant during the promotion; both the pool and silo capture every write; row counts match.
- **Demotion path**: the same scenario in reverse.

### Step 9 — ADRs

- `adr/0025-distributed-postgres-choice.md` — Citus vs Yugabyte vs CockroachDB vs sharded-by-app; the Phase 2 choice + Phase 3 graduation triggers.
- `adr/0026-tenant-promotion-saga.md` — the saga shape, the dual-write window, the cutover semantics, the one-way delete step.

---

## Definition of done

- [ ] Citus cluster (coordinator + 2 workers) running for `sms_sis`.
- [ ] Tenant-scoped tables converted to distributed via `create_distributed_table`.
- [ ] All Phase 1 tests (including cross-tenant) still pass.
- [ ] Tenant promotion saga implemented; full end-to-end happy path.
- [ ] Dual-write window works; concurrent writes during promotion preserved in both clusters.
- [ ] Cutover is atomic at the registry; downstream caches invalidate within 1s.
- [ ] Tenant demotion saga (reverse direction) works.
- [ ] Mid-saga failure tests: compensation leaves tenant in coherent state.
- [ ] Registry `tier` + `cluster_id` fields drive routing.
- [ ] ADR-0025 (distributed Postgres) and ADR-0026 (promotion saga) written.

---

## Reflection questions

1. **Why distribute by `tenantId` and not by `studentId`?** Walk through the alternative — what queries become broadcast?
2. **The promotion saga's last step is `delete-from-pool`. Why is that one-way? What does compensation look like if it fails?**
3. **During the dual-write window, the pool and silo diverge by one event. What's the reconciliation?**
4. **A customer asks "what's the downtime during my promotion?" Defend the answer with the saga's actual mechanics.**
5. **Citus is one answer; you wrote the ADR. Name the condition that would flip you to CockroachDB.**

---

## References

- Citus documentation: <https://docs.citusdata.com/>
- "Pets vs cattle" the multi-tenant edition (Citus blog series on tenant patterns)
- pg_repack: <https://reorg.github.io/pg_repack/>
- AWS RDS Blue/Green deployment docs — the production analog of the cutover pattern
- Internal:
  - `docs/adr/0001-tenancy-tier-model.md` — the tier model this milestone productizes
  - `docs/adr/0011-saga-orchestration-vs-choreography.md` — the saga pattern this builds on
  - `apps/enrollment-service/src/sagas/saga.executor.ts` — the executor we'd reuse for the promotion saga
