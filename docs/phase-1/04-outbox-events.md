# Phase 1.4 — Outbox + first event consumer

> **Concepts:** the dual-write problem, transactional outbox pattern, outbox relay (polling vs LISTEN/NOTIFY vs Debezium), at-least-once delivery, idempotent consumers, event ordering (per-aggregate vs global), OTel context propagation through events, dead-letter handling
> **Estimated effort:** 3 weekends — the failure-mode tests are slow to design and the lesson is in the design, not the code
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 1.0–1.3 complete
> - Read [`../../documentation.md`](../../documentation.md) §3.2 (Event-driven, CQRS, event sourcing) and §3.3 (Sagas)
> - Read Chris Richardson's posts on `microservices.io` for *Transactional Outbox*, *Idempotent Consumer*, and *Saga* (preview for milestone 1.5)

---

## What you'll learn

- The **dual-write problem**: why writing to a database and a message broker in two separate steps is unsafe, and the failure modes that follow ("DB written, event lost" and "event sent, DB rolled back").
- The **transactional outbox** pattern: writing the event in the same DB transaction as the state change, with a separate process relaying outbox rows to a message bus.
- Three relay implementations and their tradeoffs:
  - **Polling** (simple, slight latency, easiest to reason about)
  - **LISTEN/NOTIFY** (lower latency, Postgres-only, lossy on connection drops)
  - **Debezium / WAL CDC** (production-grade, complex to operate)
- **Idempotent consumers**: dedup by event ID, the role of a `processed_events` table, and why "exactly-once" is a marketing term that no production system actually delivers.
- **Event ordering** guarantees: per-aggregate ordering is achievable; global ordering rarely is. What this means for downstream consumers.
- **OTel context propagation through events** — why you must pass `traceparent` and `tenantId` baggage as part of every event payload, and how to verify it works.
- **Dead-letter handling** for poison messages — events that fail every retry. How to surface them without blocking the queue.
- The progression from `LISTEN/NOTIFY` to Kafka — when the upgrade is actually justified vs. premature.

---

## Why this matters (senior perspective)

The "we updated the database but the event never fired" bug class is the most common consistency failure in event-driven systems. The shape:

```
async createStudent(input) {
  const student = await prisma.student.create({ ... });   // succeeds
  await kafka.send('student.created', student);            // network blip → fails
  return student;                                          // returns success to caller
}
```

The student exists in the database. No event was published. Downstream services (Notification, Analytics, the parent BFF cache) never know the student exists. The user-visible symptom appears later: "I created my child's account but never received a welcome email." The cause is a ten-second network hiccup three weeks ago.

The transactional outbox fixes this by making the event publish part of the same atomic database transaction as the state change. A separate relay process then forwards outbox rows to the broker. The broker can be down for hours; events accumulate; when the broker recovers, all events are delivered. The DB is the source of truth for "what happened"; the broker is the transport.

The senior posture: **never publish events outside a transaction.** It's a discipline, not a tool — every service in this system must follow it, and every code review checks for it.

The **idempotent consumer** is the other half. Outbox guarantees at-least-once delivery; the relay can crash after delivering an event but before marking it processed, and the event will be redelivered. Consumers must handle the duplicate. The cure is a `processed_events` table (or Redis SET) keyed by event ID — check first, no-op if seen.

Beginners wave their hands at idempotency. Senior engineers prove it by writing a test that sends the same event twice and asserts the side effect happens once.

The third senior moment is **starting with LISTEN/NOTIFY before Kafka**. Kafka is the right answer for the production architecture; it is not the right answer to learn what's actually happening. LISTEN/NOTIFY is ~50 lines of code, runs in the database you already have, and exposes the failure modes (lost notifications on connection drop, unbounded backlog if consumer is slow) without the operational tax. Once you've felt those failure modes, you can write the ADR for "why we will move to Kafka in Phase 2." Without feeling them, you'd be cargo-culting.

---

## Hands-on plan

### Step 1 — Define the outbox table

In `sis-service`'s schema:

```
model OutboxEvent {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String   @db.Uuid
  aggregateId  String   @db.Uuid                  // e.g. studentId
  aggregateType String                             // e.g. "Student"
  eventType    String                              // e.g. "student.created"
  payload      Json
  metadata     Json                                // traceparent, tenantId baggage, schema version
  occurredAt   DateTime @default(now())
  processedAt  DateTime?

  @@index([processedAt, occurredAt])               // for relay polling
  @@index([aggregateId, occurredAt])               // for per-aggregate ordering
}
```

The `OutboxEvent` table lives in the same database as the aggregate it relates to. It is *not* a control-plane concern.

**RLS on outbox:** apply the same `tenant_isolation` policy. An outbox row is tenant-scoped by definition.

### Step 2 — Wire the outbox into the use case

The `CreateStudentUseCase` from milestone 1.3 currently calls `events.publish(new StudentCreatedEvent(...))` — that publisher writes to a synchronous in-memory bus. Replace it with one that writes to the outbox table inside the same Prisma transaction:

```typescript
async execute(input: CreateStudentInput): Promise<StudentId> {
  return await this.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    const student = Student.create({...});
    await this.repo.save(student, tx);                              // uses tx
    await this.outbox.append(tx, new StudentCreatedEvent(...));     // uses tx
    return student.id;
  });
}
```

Two operations, one transaction. Either both commit or neither does. The relay will eventually publish what's committed.

**Subtlety:** the `repo.save` and `outbox.append` must accept the transaction client (`tx`) so they don't open new transactions of their own. Adjust the repository interface — `save(student, tx?)` — accordingly.

### Step 3 — Build the outbox relay (polling implementation first)

A separate NestJS provider (`OutboxRelay`) running in a dedicated worker process — not in the gateway, not in sis-service's request handlers. Use `@nestjs/schedule` for the polling loop, or a dedicated `apps/sis-worker/`.

Pseudocode:

```typescript
@Injectable()
export class OutboxRelay {
  async tick() {
    const batch = await this.prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { occurredAt: 'asc' },
      take: 100,
    });
    for (const event of batch) {
      try {
        await this.transport.publish(event);
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
      } catch (err) {
        // log, increment metric, leave for next tick
      }
    }
  }
}
```

Run `tick()` every 1 second. Add OTel spans around the relay loop. Metrics: outbox lag (oldest unprocessed `occurredAt` vs now), publish error rate.

**Locking:** if you run multiple relay replicas, they will all try to publish the same events. Use `SELECT ... FOR UPDATE SKIP LOCKED` to claim a batch atomically. Or run a single relay replica behind a leader-election lock (Redis or Postgres advisory lock).

### Step 4 — Choose the transport: LISTEN/NOTIFY for now

Implement `transport.publish(event)`:

```typescript
async publish(event: OutboxEvent) {
  const channel = `events_${event.eventType.replace(/\./g, '_')}`;
  await this.prisma.$executeRawUnsafe(
    `NOTIFY "${channel}", '${JSON.stringify(event)}'`
  );
}
```

Limits to know about:
- Postgres NOTIFY payloads are limited to 8000 bytes by default. Larger events: notify with the event ID only, consumer reads the full row.
- Notifications are delivered only to currently-listening connections. If a consumer is restarting, the notification is lost.
- That last point is *exactly* why this is a learning step: you'll feel why the outbox needs the relay to be durable (re-poll on consumer restart), not just a fire-and-forget broadcast.

### Step 5 — Generate the academic-service and wire the consumer

1. `nx g @nx/nest:app academic-service`. Apply the structure from milestone 1.3 (clean architecture).
2. Define minimal entities in academic-service's schema: `Course`, `Section`, `EnrollmentSlot` (an empty slot waiting to be filled by a student). RLS on every table.
3. Build the consumer:

```typescript
@Injectable()
export class StudentEventsConsumer implements OnModuleInit {
  async onModuleInit() {
    const client = await this.pool.connect();
    await client.query('LISTEN events_student_created');
    client.on('notification', async (msg) => {
      const event = JSON.parse(msg.payload!);
      await this.handle(event);
    });
  }
  async handle(event: StudentCreatedEvent) {
    // idempotency check
    const seen = await this.processed.has(event.id);
    if (seen) return;

    // restore tenant context from event metadata
    await this.cls.run({ tenantId: event.tenantId }, async () => {
      // do the side effect: create an EnrollmentSlot for the new student
      // ...
    });

    await this.processed.mark(event.id);
  }
}
```

Two non-obvious bits:

- **CLS/tenant context restoration**: the consumer is not in an HTTP request, so the tenant context isn't auto-populated. Restore it from the event metadata.
- **Idempotency**: the `processed` store dedups by event ID. Use a Postgres table (`processed_events(event_id PK, processed_at)`) with an `INSERT ... ON CONFLICT DO NOTHING` semantic.

### Step 6 — OTel propagation through events

Every event metadata must carry the trace context:

```typescript
const carrier = {};
propagation.inject(context.active(), carrier);
const event = {
  ...,
  metadata: {
    traceparent: carrier.traceparent,
    tenantId: cls.get('tenantId'),
    schemaVersion: 1,
  },
};
```

In the consumer, extract and continue the trace:

```typescript
const parent = propagation.extract(ROOT_CONTEXT, event.metadata);
await context.with(parent, async () => {
  await this.handle(event);
});
```

Verify in your local Tempo: a `POST /students` request shows the gateway → SIS → outbox span, and the consumer's handling appears as a child span — across services, across processes, across network — in *one* trace. This is the moment distributed tracing earns its keep.

### Step 7 — Failure-mode tests

This is where the milestone differentiates from a tutorial. Write tests that prove the system survives failures:

- **Test:** kill the relay between publish and `processedAt` update. Restart it. Event is re-published. Consumer receives it twice. Side effect happens once (idempotency).
- **Test:** start the consumer *after* the relay has published. The notification was lost (`LISTEN/NOTIFY` is lossy). The relay's polling re-publishes the unprocessed event eventually. Consumer eventually catches up. Document the latency.
- **Test:** publish 10,000 events as a burst. Consumer is slow (sleep 50ms in handler). Verify no events are lost, only delayed. Measure outbox lag over time.
- **Test:** corrupt one event's payload (set to non-JSON). Consumer fails forever on it. Verify it doesn't block other events (poison message handling — see step 9).

These are the tests senior engineers write because they've seen each of these failure modes in production. Junior engineers write happy-path tests and discover the failure modes during incidents.

### Step 8 — Per-aggregate ordering

A consumer reading two events for the same student in the wrong order (e.g., `student.deleted` before `student.created`) breaks. The pattern:

- Per-aggregate ordering: events for the same `aggregateId` are processed in `occurredAt` order. The relay publishes in order; the consumer processes them serially per aggregate.
- Cross-aggregate is unordered. Two different students' creates can be processed concurrently.

In LISTEN/NOTIFY (or Kafka with a single partition), serial processing per consumer instance gives this for free. With multiple consumer instances, you need partitioning by `aggregateId`. Note this in your ADR — it's a constraint that drives Phase 2 transport choices.

### Step 9 — Dead-letter handling

A poison event (one that fails every retry) must not block subsequent events. Pattern:

- After N retries (e.g., 5), the consumer marks the event as failed and moves on.
- A `dead_letter_events` table holds the failed payload + error.
- A human operator (or a stretch-goal automation) processes the dead-letter table.

Alternatively, a "dead letter and continue" inside the relay: if the consumer fails to ack within a timeout window, the event is moved to dead-letter and the next is delivered. The exact mechanism depends on transport.

### Step 10 — Write the ADRs

At least two:
- [`adr/0008-outbox-pattern.md`](../adr/) — why outbox over dual-write, and why polling relay vs alternatives.
- [`adr/0009-event-transport-choice.md`](../adr/) — LISTEN/NOTIFY for Phase 1, with explicit conditions under which Phase 2 upgrades to Kafka (e.g., > N events/sec, multi-region, multiple consumer groups).

---

## Definition of done

- [x] `OutboxEvent` table exists in sis-service; RLS-enabled; `tenant_isolation` policy. *(commit `dcc2072`)*
- [x] `CreateStudentUseCase` writes Student + OutboxEvent in a single Prisma transaction. *(commit `528508d`; verified by `use-cases.spec.ts` "appends a student.created outbox event in the same tx")*
- [x] `OutboxRelay` polls every 1s, publishes to LISTEN/NOTIFY, marks `processedAt`. *(commit `4ee90ea`; setTimeout chain with reentrancy guard, NOT setInterval)*
- [x] Multiple relay replicas (if any) use `FOR UPDATE SKIP LOCKED` — no double-publish. *(in `outbox.relay.ts`; not exercised under load — single replica today)*
- [x] `academic-service` consumes `student.created`, idempotent via `processed_event` table. *(commit `3ee13d5`; `INSERT ... ON CONFLICT DO NOTHING RETURNING` pattern; covered by `student-events.consumer.spec.ts` 5/5 passing)*
- [x] OTel `traceparent` propagated through events. *(`OutboxService.append` injects via `propagation.inject`; consumer extracts via `propagation.extract` and runs the handler inside `context.with`. End-to-end Jaeger verification deferred until 1.8 stands up the collector.)*
- [ ] Failure-mode tests — **partial; deferred to 1.8 (observability)**:
  - [~] Relay killed mid-publish: event redelivered; side effect happens once. *(Design defends: NOTIFY + UPDATE atomic-on-COMMIT. Not exercised under fault injection.)*
  - [ ] Consumer restart loses notification: relay's polling redelivers. *(NOT YET — startup catch-up is not implemented; documented as a known risk in ADR-0009. Phase 1.4 ships best-effort delivery.)*
  - [ ] Burst of 10,000 events: no loss; lag measured. *(NOT TESTED — needs Testcontainers harness; tracked for milestone 1.8.)*
  - [ ] Poison event: doesn't block queue; dead-lettered. *(NOT YET — DLQ not implemented; consumer logs and continues. Documented in ADR-0009.)*
- [ ] Outbox lag and consumer error rate metrics in Prometheus. **Deferred to milestone 1.8 (observability).**
- [x] ADR-0009 (outbox) and ADR-0010 (transport choice) written. *(`docs/adr/0009-transactional-outbox-pattern.md`, `docs/adr/0010-listen-notify-transport.md`. Numbers shifted by 1 because ADR-0008 was already taken by clean architecture in milestone 1.3.)*

**End-to-end smoke test (manual, recorded in conversation):** POST a student
→ outbox row written in same tx → relay tick publishes → consumer receives
NOTIFY → restores tenant context → INSERTs into `enrollment_slot` in
`sms_academic`. Verified the slot exists with the correct tenantId and
studentId, and `processed_event` records the eventId under
`consumerName=academic-student-events`. End-to-end latency was ~1.5s
(dominated by the 1s relay tick interval).

**Tests:** sis-service 60+ tests passing (use cases + integration +
cross-tenant); academic-service 5/5 consumer dedup unit tests.

---

## Common pitfalls

1. **Publishing events outside the transaction.** "I'll just call `kafka.send` after the commit" — you've reintroduced dual-write. The outbox must be inside the transaction.
2. **Marking `processedAt` before delivery is acked.** Consumer never gets the event; relay thinks it did. Mark *after* the broker confirms receipt.
3. **Single relay replica without leader election.** Acceptable if you accept the single point of failure; document it. If multiple replicas, you need locking.
4. **No idempotency on the consumer.** First time the relay redelivers an event (and it will), your downstream side effect happens twice.
5. **Idempotency by "natural key" instead of event ID.** A natural-key check works until two events for the same key carry different intents (rename then delete). Use the event ID.
6. **Forgetting OTel context in the event.** The consumer's spans appear as orphaned roots; you can't trace cross-service. Fix it now or never.
7. **Storing tenant context only in CLS.** When the consumer runs, CLS is empty. The event metadata must carry `tenantId`, and the consumer must restore it before any DB query.
8. **Trying to use LISTEN/NOTIFY for ordering guarantees it doesn't provide.** It's broadcast and lossy. The relay's polling is what gives you the durable order.
9. **No dead-letter strategy.** A single poison event blocks the entire queue. Build the DLQ pattern early.
10. **Reaching for Kafka on day one.** Without feeling LISTEN/NOTIFY's failure modes, you don't know what Kafka actually buys you. Earn the upgrade.

---

## Stretch goals (optional rabbit holes)

- **Replace LISTEN/NOTIFY with Kafka (or Redpanda for less ops).** Compare ergonomics. Note where Kafka actually helps (consumer groups, replay, retention) and where it adds friction (operator burden, rebalances).
- **Add Debezium CDC** on the outbox table. Now the relay is operationally a different shape — Postgres → Debezium → Kafka. Compare with the application-level relay.
- **Implement schema versioning for events.** Add `metadata.schemaVersion`; consumers handle v1 and v2 differently. This is the contract management discipline you'll need in Phase 2.
- **Build a `/ops/outbox` admin endpoint** showing lag, top-N stuck events, recent dead-letters. Operational tooling is a senior productivity habit.
- **Measure end-to-end latency from publish to consume.** Set an SLO: p95 < 2s, p99 < 10s. Alert on breaches.
- **Replay capability**: an admin endpoint that re-publishes events for a given aggregate. Useful for "this consumer was broken for an hour; replay yesterday."
- **Read the Pat Helland paper *Life Beyond Distributed Transactions: An Apostate's Opinion***. It's the philosophical underpinning of the outbox pattern.

---

## Reflection questions

1. **Why is dual-write to the database and the broker unsafe?** Walk through the failure scenarios (DB succeeds, broker fails; broker succeeds, DB rolls back).
2. **What is the difference between at-most-once, at-least-once, and exactly-once delivery?** Which one does outbox + idempotent-consumer give you, and what does "exactly-once" really mean in practice?
3. **The relay redelivered an event. Your handler ran twice. What in your code prevented the side effect from happening twice?** Walk through the line of code.
4. **You chose LISTEN/NOTIFY over Kafka. State the conditions under which this choice flips.** (This is your future ADR.)
5. **One trace spans gateway → SIS → outbox relay → academic-service consumer. What had to be done at each hop for the trace to remain unbroken?**
6. **A poison event could fail forever. What's your strategy, and how does it interact with the SLO on outbox lag?**
7. **Your relay has been running for a year. The `OutboxEvent` table is 500 GB. What's your retention strategy?** (You don't need to implement it; you need to have an answer.)

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §3.2 (event-driven), §3.3 (sagas — preview).
- **Chris Richardson, `microservices.io`:** *Transactional Outbox*, *Idempotent Consumer*, *Polling Publisher*.
- **Confluent blog:** *The Transactional Outbox Pattern with Postgres and Debezium*.
- **Pat Helland, *Life Beyond Distributed Transactions: An Apostate's Opinion*** (CIDR 2007).
- **OpenTelemetry context propagation docs:** specifically the `propagation.inject` / `propagation.extract` API for trace context across non-HTTP boundaries.
- **Postgres docs:** *NOTIFY*, *LISTEN*, *Server-Side Programming with NOTIFY*.

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.4 to `Done`. Move to milestone 1.5 (First saga: Enrollment). The events you publish now will become the steps of a workflow.
