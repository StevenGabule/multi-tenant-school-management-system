# ADR-0009: Transactional outbox for cross-service event publishing

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Milestone 1.4 introduces cross-service event flow: `sis-service` mutates a
`Student`, and `academic-service` reacts by creating an `EnrollmentSlot`.
Each service has its own database (`sms_sis`, `sms_academic`). There is no
shared transaction that spans both — Postgres is one DB at a time.

The naive design — `await db.insert(student); await broker.publish(event)` —
has a textbook failure mode known as **dual-write**:

  1. `db.insert` commits.
  2. The process crashes before `broker.publish`.
  3. The student exists; nobody knows. The downstream slot is never created.
     The system is silently inconsistent.

Reversing the order doesn't help — now you can publish events for students
that never persisted (the `db.insert` rolls back).

This is THE classic distributed-systems problem and the project plans
fifteen+ services emitting domain events to one another. Getting this
wrong locks in inconsistency as a baseline.

## Decision

**We adopt the Transactional Outbox pattern.**

```
       writes the row + the event row in ONE transaction
       ┌─────────────────────────────────┐
       │                                 │
   ┌───▼───────┐    ┌──────────────────┐ │
   │ student   │    │ outbox_event     │ │ both commit or both roll back
   │ (RLS)     │    │ (RLS)            │ │
   └───────────┘    └────────┬─────────┘ │
                             │           │
       ┌─────────────────────┘           │ relay reads the table,
       │                                 │ marks rows processed,
   ┌───▼─────────────┐                   │ publishes to the broker
   │ OutboxRelay     │ ──────────────────┘ (NOTIFY in Phase 1, Kafka in Phase 2)
   │ (BYPASSRLS)     │
   └─────────────────┘
```

### Specific rules

1. **The outbox row goes in the SAME transaction as the state change.**
   `OutboxService.append(tx, ...)` always takes the caller's `Prisma.TransactionClient`.
   Atomic by construction — no use case can publish an event without
   committing the row, and vice versa.

2. **Producers write under tenant RLS.** The `outbox_event` table has
   `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with the
   same `tenant_isolation` policy used elsewhere. A use case running as
   tenant A *cannot* insert an event tagged tenant B. RLS makes the
   wrong outcome impossible, not just unlikely.

3. **The relay bypasses RLS.** `sms_app` (the role that owns the relay's
   pg connection) has `BYPASSRLS`. The relay needs to see ALL tenants'
   rows to drain them. The role lives on a dedicated `SIS_OUTBOX_URL`
   that bypasses PgBouncer transaction mode (LISTEN connections must be
   long-lived and session-scoped).

4. **Polling, with `FOR UPDATE SKIP LOCKED` for safety under multiple
   replicas.** Two concurrent relays will not double-publish a row —
   each `SELECT ... FOR UPDATE SKIP LOCKED` claims a disjoint set,
   commits, and continues. No leader election; no single-point-of-failure;
   no Zookeeper.

5. **Tick cadence: 1s `setTimeout` chain (NOT `setInterval`), with a
   reentrancy guard.** A slow tick will not stack on top of itself,
   which is the failure mode that caused multiple outages in production
   systems I've read about. (The chained setTimeout is the boring,
   correct version of "every second.")

6. **Trace context lives in the event metadata.** The producer captures
   `traceparent` via OpenTelemetry's `propagation.inject` at outbox
   append time. The consumer reconstructs it via `propagation.extract`
   so the consumer's spans show up under the same trace as the producer's.

7. **`occurredAt` is set at row insert, not at relay tick.** The event
   timestamp reflects when the business fact occurred, not when delivery
   happened. Critical for ordering guarantees and debugging.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Direct dual-write (publish after commit)** | One file change; "ship it" simplicity | Silently loses events on process crash, network blip, or broker outage. EVERY production outage I've seen with this pattern was a dual-write race | This is what we're explicitly avoiding |
| **Two-phase commit (XA across DB and broker)** | Real ACID across both stores | Postgres + Kafka don't agree on XA; RabbitMQ's XA support has known issues; the world has rejected XA for distributed messaging since ~2010 | Even if it worked, ops complexity is unjustifiable for one-engineer team |
| **CDC (Debezium reads the WAL)** | No code change in the producer; events are derived from the actual DB write | Operational overhead (Kafka Connect, Debezium config, schema registry); event payload is the row shape, not the domain event shape; harder to evolve | Right answer at scale, wrong answer for milestone 1.4 — re-evaluate in Phase 2 |
| **Transactional Outbox (chosen)** | Atomicity guaranteed by Postgres; event payload is hand-crafted (domain shape, not row shape); transport is replaceable (NOTIFY now, Kafka later); standard pattern with extensive lit | One extra table per service; relay process to operate; ordering is per-aggregate, not global | n/a — well-understood tradeoffs |
| **Logical-decoding-with-payload-column** | Hybrid: domain payload + WAL-based delivery | The complexity floor of Debezium without the ecosystem | Worst of both worlds at this scale |

## Consequences

**Positive:**

- Atomicity is structural, not procedural. There is no code path where
  a student is created without an event, or an event without a student.
  This is verifiable in tests (Step 9: deliberate rollback in the use
  case → outbox row absent).
- The transport is decoupled. Phase 1 uses Postgres `LISTEN/NOTIFY`
  (see ADR-0010); Phase 2 swaps the relay for a Kafka producer without
  touching domain code, use cases, or the outbox table itself.
- Replay is trivial. The `outbox_event` table retains all history; a
  replay tool can re-publish events for a given aggregate or time range.
  Useful for backfilling new consumers in Phase 2.
- Per-aggregate ordering is preserved by the `(aggregateId, occurredAt)`
  index. The relay reads in `occurredAt ASC` order; consumers process
  in delivery order. This is weaker than Kafka's per-partition guarantee
  but stronger than at-most-once.

**Negative / costs:**

- One extra DB table per service that emits events. Storage cost is
  negligible (events are small, retention can be capped — see Phase 2
  cleanup job).
- Latency: events are delivered after the relay's poll-and-publish
  cycle. With 1s tick and `pg_notify` (sub-ms), tail latency is ~1s
  worst-case. Acceptable for everything in Phase 1; reads-your-writes
  scenarios across services need the saga (milestone 1.5), not the outbox.
- The relay is a stateful process. It needs a connection that bypasses
  PgBouncer transaction mode (PgBouncer drops session state mid-transaction).
  A dedicated `SIS_OUTBOX_URL` env var carries this. Documented; easy to
  miss if a future engineer "consolidates" connection strings.
- ProcessedAt is a column on the producer's table — a relay-side update.
  Producers writing to `outbox_event` and the relay updating the same
  row is the only place the relay touches producer-owned data. Acceptable
  because the relay is operationally trusted and writes only that one
  column.

**Risks:**

- **Catch-up on consumer startup is NOT YET implemented.** If the
  consumer is down when the relay publishes, those NOTIFY messages are
  lost (NOTIFY is fire-and-forget). Consumer must, on startup, query the
  relay's source (or a downstream cursor) for events newer than its
  last-seen `occurredAt`. Today: **best-effort delivery**. Phase 2 (or
  earlier if pain emerges) adds a startup catch-up query.
- **No DLQ for poison messages.** A consumer that throws on a specific
  event will throw on every redelivery (if redeliveries existed). Today
  the event stays "unprocessed" forever-ish (NOTIFY's at-most-once
  semantics) and the consumer logs the error. Phase 2 adds a
  `failed_event` table with retry counts.
- **Single-replica relay assumption is acceptable today, not at scale.**
  `FOR UPDATE SKIP LOCKED` makes multi-replica safe; we're just not
  running multiple. When we do (Phase 2), we'll need to validate the
  pattern under real load.
- **Outbox table grows unbounded.** Events are never deleted. In Phase 1
  with a few writes/sec this is fine. Phase 2 needs a cleanup job
  (`DELETE WHERE processedAt < NOW() - INTERVAL '7 days'`) — sized to
  whatever the longest replay window is.

**Follow-up work this enables / forces:**

- Milestone 1.5 (saga): the saga reads outbox events via the same relay,
  writes saga steps in the same transaction-per-step. Outbox is the
  delivery substrate.
- Phase 2 (Kafka migration): replace the relay's `pg_notify` call with
  a `kafka.produce(topic, key=aggregateId, value=envelope)`. Domain code,
  outbox table, and migrations stay untouched.
- Phase 2 ESLint rule: any code that calls a broker's publish API
  directly (instead of `OutboxService.append`) is rejected.
- Phase 2 monitoring: outbox lag (oldest unprocessed `occurredAt`),
  relay tick duration p99, NOTIFY publish error rate. The lag metric is
  the single most-important signal — alert when > 30s.

## References

- Chris Richardson, *Microservices Patterns* (2018) — chapter 3 popularised
  this name.
- Pat Helland, "Life Beyond Distributed Transactions" (2007) — the
  philosophical case for outbox-style patterns over XA.
- Gunnar Morling, "Reliable Microservices Data Exchange With the Outbox
  Pattern" (Debezium blog, 2019) — the WAL-based variant we considered
  and rejected.
- Internal:
  - `apps/sis-service/prisma/migrations/20260510075017_add_outbox/migration.sql`
    — table + RLS + indexes
  - `apps/sis-service/src/outbox/outbox.service.ts` — append API
  - `apps/sis-service/src/outbox/outbox.relay.ts` — polling worker
  - `apps/sis-service/src/modules/students/application/create-student.use-case.ts`
    — first producer; the canonical example
- Phase 1.4 milestone: [`../phase-1/04-outbox-and-event-consumer.md`](../phase-1/04-outbox-and-event-consumer.md)
- Related: [ADR-0010](0010-listen-notify-transport.md) (the transport choice)
- Related: [ADR-0005](0005-rls-tenant-isolation.md) (outbox is RLS-protected)
- Related: [ADR-0008](0008-clean-architecture-layering.md) (the use case
  layer is what calls `OutboxService.append`)
