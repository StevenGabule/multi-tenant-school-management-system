# ADR-0010: Postgres LISTEN/NOTIFY as the Phase 1 event transport

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

ADR-0009 commits us to the Transactional Outbox pattern: events live in a
Postgres table; a relay drains them; consumers receive them. The transport
between relay and consumer is a separate decision.

The "obvious" production choice in 2026 is Apache Kafka (or a managed
equivalent like Confluent Cloud, AWS MSK, Redpanda, etc.). Kafka offers:
durable storage, partitioned ordering, consumer groups, replay, and an
industry-standard schema registry.

It also has costs that matter for a learning project run by one engineer
on a development laptop: 3+ broker nodes, Zookeeper or KRaft, schema
registry, Kafka UI for debugging, container memory pressure that crashes
WSL2. Bringing Kafka up just to verify "does the consumer receive a
message?" puts a 20-minute startup tax on every iteration.

We need something that proves out the *pattern* in Phase 1 without the
operational footprint, while preserving a clean migration path to Kafka
in Phase 2 once the patterns are real and the use cases concrete.

## Decision

**Phase 1 transport is `pg_notify` / `LISTEN`. The relay calls
`pg_notify(channel, payload)`; the consumer holds a long-lived `pg`
client in LISTEN mode. Phase 2 replaces the transport with Kafka
without touching producer or consumer business logic.**

### Specific rules

1. **One channel per producing service**, named `sms.<service>.outbox`.
   sis-service publishes on `sms.sis.outbox`. academic-service (when it
   eventually emits events) will publish on `sms.academic.outbox`.
   Channel names go in env (`SIS_OUTBOX_CHANNEL=sms.sis.outbox`) so
   tests can inject distinct channels.

2. **The payload is the full event envelope** (`id`, `tenantId`,
   `aggregateId`, `aggregateType`, `eventType`, `payload`, `metadata`,
   `occurredAt`) as JSON. Not just the event id — fetching the row
   would race the relay's `processedAt` UPDATE.

3. **The 8KB Postgres NOTIFY payload limit is a hard constraint we
   accept.** Domain events in this project are small (IDs, names, dates).
   If an event ever needs to carry > 8KB, the design is wrong — store
   the blob, NOTIFY with a reference. Discovered in Phase 2 → migrate
   to Kafka, where this limit doesn't exist.

4. **NOTIFY is queued within the transaction; delivered only on COMMIT.**
   This is the critical invariant. The relay's `UPDATE outbox_event
   SET processedAt = NOW()` and `pg_notify(...)` are in the SAME
   transaction. If the COMMIT fails, neither happens — the row stays
   unprocessed and a future tick retries. If the COMMIT succeeds,
   downstream LISTENers receive exactly the events the relay claimed
   to mark processed. **Atomic delivery + processedAt marker.**

5. **Consumer connection bypasses PgBouncer.** Long-lived LISTEN
   connections do not survive transaction-pooling — PgBouncer drops
   the session-scoped LISTEN registration when the underlying
   connection rotates. The consumer reads from `ACADEMIC_LISTEN_URL`,
   which points at Postgres directly (port 5432, not the pooler).
   Documented in `.env.example` with a comment.

6. **Cross-database LISTEN.** academic-service connects to `sms_sis` (NOT
   its own database) for the LISTEN. NOTIFY channels are database-scoped;
   the consumer must be on the same DB as the producer. Writes still go
   to `sms_academic`. Two connections per consumer process: one to read
   notifications, one (via Prisma) to write its own state.

7. **Idempotency is the consumer's responsibility.** NOTIFY has at-most-
   once delivery semantics during steady state, but a misbehaved client
   *could* receive a duplicate (e.g., reconnection logic that resubscribes
   after a network blip). The `processed_event` table with `(eventId,
   consumerName)` PK and `INSERT ... ON CONFLICT DO NOTHING RETURNING`
   makes the handler exactly-once *for the work it does*, which is what
   actually matters.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Apache Kafka (or managed)** | Industry standard; durable; partitioned; replay built-in; schema registry ecosystem | 3+ broker nodes; Zookeeper/KRaft; 1–2GB RAM minimum on the dev laptop; 20-min startup; outsized ops complexity for one engineer | Right answer for production at scale; wrong answer for Phase 1 learning iterations — Phase 2 |
| **NATS / RabbitMQ / Redis Streams** | Lighter than Kafka; cheap to run | Adds a *third* component to the stack (DB + broker + consumer); each has a different operational story; tied to a vendor we'd then need to remove or migrate | Why add infrastructure for a Phase that will be torn down? |
| **In-process EventEmitter (single binary)** | Zero infrastructure; trivial | Defeats the entire point of microservices; dual-write back since "publish" is in-memory | Misses the point of milestone 1.4 |
| **Postgres LISTEN/NOTIFY (chosen)** | Already running Postgres; transport is a SQL function call; payload-with-COMMIT atomicity is exactly what we want; visible in Postgres logs for debugging | 8KB payload limit; no replay (NOTIFY is fire-and-forget); no consumer groups; cross-database needs the consumer to connect to the producer's DB | n/a — perfect for Phase 1 |
| **`pgmq` (Postgres-as-queue extension)** | Persistent queue semantics on top of Postgres; closer to Kafka mental model | Extension; not on managed Postgres without admin access; one more thing to install | Marginal benefit over plain NOTIFY for our scale |
| **Pub/Sub via a JSON-column polling consumer** | Producer writes to a `pending_events` table; consumer polls every 100ms | Bigger DB load; reinvents NOTIFY in user space; latency floor is the poll interval | Poor cost/value vs. native NOTIFY |

## Consequences

**Positive:**

- Setup cost is zero. Postgres is already running for the application
  database; LISTEN/NOTIFY adds no new container, no new credentials, no
  new secret to manage. The consumer is ~150 lines of code total.
- Debugging is trivial. `psql -c "LISTEN sms.sis.outbox"` in another
  terminal shows every notification in real time. With Kafka, you reach
  for `kafka-console-consumer.sh` plus credentials plus the right
  bootstrap servers; with NOTIFY, it's one line.
- The atomicity property (NOTIFY-on-COMMIT) is *stronger* than what most
  brokers natively offer with the outbox. With Kafka we'd still need
  the relay to manage the COMMIT-then-publish handoff (and acknowledge
  failures). With NOTIFY, the database does that for us.
- Migration path is clean. The relay is the only file that calls the
  transport API. Replacing `pg_notify` with `producer.send(topic, ...)`
  is a 20-line change in one file, plus producer config. The producer
  use cases, the outbox table, the consumer's handler logic, the
  envelope shape — none of it changes.

**Negative / costs:**

- **No replay.** If a consumer is down when NOTIFY fires, it doesn't
  see the event. We mitigate by querying the producer's outbox table
  on startup for unprocessed-by-this-consumer events (Phase 2 — see
  ADR-0009 risks). Today: **catch-up is not implemented**; demo flows
  assume the consumer was up.
- **No partitioning / consumer groups.** Two consumer processes both
  LISTENing on the same channel each receive every NOTIFY — there's no
  load balancing. Single-process consumer is fine for Phase 1; Phase 2
  needs Kafka's consumer-group semantics for horizontal scale.
- **Cross-database connection coupling.** academic-service must know
  sis-service's database connection string. This is fine in dev (local
  Postgres) and acceptable in staging/prod with private networks; in a
  zero-trust environment, the consumer should consume from a *broker*,
  not the producer's DB. Phase 2 fixes this naturally — Kafka topics
  are the consumer's contact point, not the producer's database.
- **8KB payload limit.** Discussed under "Specific rules" #3. We accept
  it; if it bites, that's a signal the event design is wrong or the
  transport choice has hit its ceiling.
- **PgBouncer bypass requirement.** Easy to forget when adding a new
  consumer. Documented in `.env.example` and ADR-0009 references; needs
  to be in the new-service checklist (TBD when we write one).

**Risks:**

- A future engineer adds a consumer and configures it through PgBouncer
  for "consistency with the app". LISTEN silently stops working after
  the first connection rotation. **Mitigation:** every consumer's
  connection string env var is named `*_LISTEN_URL` to flag it as
  special; comment in env files; this ADR.
- The 8KB limit is breached by a future event payload. **Mitigation:**
  payload review at PR time; reject events that approach this size.
  When it actually happens, treat it as the trigger for Phase 2 Kafka.
- An ops engineer increases NOTIFY-related Postgres timeouts globally
  to "fix" something else, breaking event timing. **Mitigation:** the
  consumer's `pg.Client` has its own statement timeout; relay tick is
  bounded by the polling interval. Both isolate from global parameter
  changes.

**Migration triggers — explicit conditions for Phase 2 Kafka cutover:**

We commit to Kafka migration when ANY of these is true:

  1. We have a consumer that requires *replay* of historical events
     (e.g., backfilling a new bounded context from existing student data).
     NOTIFY can't do this; the outbox table CAN, but plumbing replay-via-
     direct-table-read is just rebuilding Kafka in user space.
  2. We have multiple consumer instances of the SAME service and need
     load-balancing of events across them. NOTIFY broadcasts to all
     LISTENers; Kafka consumer groups distribute.
  3. An event payload exceeds 8KB (and we can't refactor it down).
  4. Cross-environment delivery (e.g., events from prod-Postgres to
     staging-consumers) becomes a requirement. NOTIFY assumes shared DB.
  5. Two of: outbox lag > 30s sustained / consumer count > 5 / events/sec
     > 100. (Order-of-magnitude thresholds — not artisanal.)

If NONE of these apply, we stay on NOTIFY. The migration is non-trivial
ops work; it must pay back in capability.

## References

- PostgreSQL docs, [`NOTIFY`](https://www.postgresql.org/docs/16/sql-notify.html)
  and [`LISTEN`](https://www.postgresql.org/docs/16/sql-listen.html) — the
  authoritative spec, including the 8KB payload limit and transactional
  delivery semantics.
- [`pg` (node-postgres) Notification example](https://node-postgres.com/features/notifications)
  — the client-side LISTEN pattern used here.
- Chris Richardson, *Microservices Patterns* (2018), chapter 3 — the
  outbox pattern. Says nothing about NOTIFY specifically; we're combining
  outbox with NOTIFY as transport, which is a known-good lightweight
  pairing for early-stage systems.
- Internal:
  - `apps/sis-service/src/outbox/outbox.relay.ts` — relay calling `pg_notify`
  - `apps/academic-service/src/consumers/student-events.consumer.ts` —
    consumer holding the LISTEN connection
  - `.env.example` — `SIS_OUTBOX_URL`, `ACADEMIC_LISTEN_URL` and the
    PgBouncer-bypass note
- Phase 1.4 milestone: [`../phase-1/04-outbox-and-event-consumer.md`](../phase-1/04-outbox-and-event-consumer.md)
- Related: [ADR-0009](0009-transactional-outbox-pattern.md) (the *what*;
  this ADR is the *how*)
