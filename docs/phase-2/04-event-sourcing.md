# Phase 2.4 — Event sourcing for high-velocity domains

> **Concepts:** event-stream-as-source-of-truth, snapshots, projections, CQRS, the read-model rebuild, schema evolution under event sourcing, idempotent projectors
> **Estimated effort:** 4 weekends — event sourcing is genuinely a different mental model
> **Status:** Not Started
> **Prerequisites:**
> - Milestone 2.0 complete (alerting + Pact catch the schema-evolution mistakes early)
> - Re-read ADR-0009 (outbox) — event sourcing is the outbox's bigger sibling

---

## What you'll learn

- **Event-stream-as-source-of-truth**: the aggregate's state IS the projection of an event stream. The "current state" row in a table is a derived artifact; the events are the truth.
- **CQRS**: writes go to the event stream; reads go to projections (denormalized read tables). The write model and read model diverge intentionally.
- **Snapshots**: at N events, persist the current state so subsequent loads don't replay the whole stream. Common at every 100 events for attendance, every 1000 for activity logs.
- **Read-model rebuild**: any projection can be deleted and re-derived from the event stream. Game-changing for "we need to add a new view; rebuild it from history."
- **Schema evolution**: events are versioned, never mutated. A v1 event remains v1 forever; a projection upgrades by re-reading the stream with the v2 interpreter.
- **The cost**: storage, complexity, the upskill curve. Event sourcing is the right answer for a domain where history matters (attendance, gradebook, audit). Wrong for domains where it doesn't (CRUD on a student's home address).

---

## Why this matters (senior perspective)

Phase 1's domain services use "state as the source of truth" — the `Student` row IS the student. Most domains work fine that way. But some don't:

- **Attendance**: "was Alice present on 2025-03-04?" → a state model would store a row per (student, date); event-sourced, you replay attendance events. The event model wins for audit + correction history.
- **Gradebook**: the grade rolled back twice and is now correct; the principal asks "what did Alice's GPA look like on Tuesday?" → state model has lost the answer.
- **Discipline**: a discipline event was issued, then redacted, then reinstated. State-based stores only the latest; event-sourced shows the full timeline.

The senior posture has three parts:

1. **Event sourcing is not for everything.** It pays back when audit, replay, or historical projections are first-class needs. It's overhead when they're not.
2. **The projections are the API; the events are private.** External consumers see read models. The event log is the internal source of truth. Confusing the two leaks abstraction.
3. **Event versioning is forever.** Once an event ships to production, it can never be deleted or restructured. v2 is additive. The senior discipline is naming events conservatively.

---

## Hands-on plan

### Step 1 — Pick the domain

The first event-sourced domain is **attendance**. Why:
- Daily high event volume (one event per (student, period, day)).
- Audit matters (regulators ask "who marked Alice absent?").
- Replay matters ("a teacher marked her class wrong yesterday; let's redo today's view based on corrected events").
- Simple enough domain model.

Gradebook and discipline come later in the same milestone IF time permits, OR in a follow-up.

### Step 2 — Event schema

```typescript
type AttendanceEvent =
  | { type: 'student.attendance.marked'; v: 1;
      tenantId: string; studentId: string; classId: string;
      date: string; period: number; status: 'present' | 'absent' | 'late';
      markedBy: string; markedAt: string }
  | { type: 'student.attendance.corrected'; v: 1;
      tenantId: string; studentId: string; classId: string;
      date: string; period: number; previousStatus: string; newStatus: string;
      correctedBy: string; correctedAt: string; reason: string };
```

Events are **immutable**. A correction is a NEW event, not a mutation of the original.

### Step 3 — Event store

Two options:
- **Pure Postgres** — an `attendance_event` table, append-only, indexed by (tenantId, studentId, date). RLS as usual.
- **Dedicated event store** — EventStoreDB, Kurrent. More feature-rich (subscriptions, projections built-in) but operational cost.

For Phase 2, Postgres. ADR-0029 records the rationale + Phase 3 graduation triggers (volume, cross-region replay, complex projections).

### Step 4 — Write path

A `MarkAttendanceUseCase`:

1. Validate the input (tenant, student, class, date).
2. Authorize (teacher can mark THEIR class; admin can mark any).
3. Append the event to `attendance_event` in a transaction.
4. **Also** append to the outbox (milestone 1.4) for downstream consumers.

The outbox + the event store are intentionally aligned: the outbox event IS the attendance event (same schema, same content). Downstream consumers (notifications, reports) consume from the outbox; the event store is the durable source for projections.

### Step 5 — The projection

A read model: `attendance_daily_view(tenantId, studentId, date, presentPeriods, absentPeriods, latePeriods)`.

A projector process consumes events from the outbox (subscribes to `attendance.*` events) and updates the view. Idempotent: each event has an ID; the projector tracks "processed up to event X" per (tenantId, view).

Failure mode: projector dies → events accumulate in outbox; on restart, projector resumes from its watermark, catches up.

### Step 6 — The read API

`GET /api/students/:id/attendance?from=...&to=...` returns from the projection. **Never queries the event stream directly** — that's the senior discipline.

For "show me the audit log of corrections," a separate API: `GET /api/students/:id/attendance/audit?date=...` reads the raw events for that date.

### Step 7 — Rebuild a projection

A scheduled job (or manual operator command):

```bash
./infra/projections/rebuild.sh --projection attendance_daily_view --tenant <uuid>
```

1. Drops the projection rows for the tenant.
2. Re-reads the event stream from the beginning, replaying through the projector.
3. Sets the new watermark.

This is the killer feature: any data shape can be rebuilt from history. Adding a new projection means writing the projector + running rebuild — no migration needed.

### Step 8 — Schema evolution

The week after launch, a teacher asks "can we mark a student as `excused`?" — a 4th status. The migration:

1. v2 of `student.attendance.marked` adds `status: 'excused'` as a valid value.
2. v1 events keep their three statuses; they still validate against v1.
3. The projector handles both: v1 events map status as before; v2 events handle the new status.

**No event is mutated.** The interpreter widens.

### Step 9 — Tests + drill

- **Append idempotency**: the same event POSTed twice creates ONE store entry.
- **Projection consistency**: 1000 attendance events appended; the daily view shows the correct counts.
- **Audit query**: a correction event is captured AND the daily view reflects the new state.
- **Rebuild correctness**: drop the view, rebuild from events, verify identical state.
- **Schema evolution**: add a v2 event, replay history, verify v1 events still project correctly.

### Step 10 — ADRs

- `adr/0029-event-sourcing-where.md` — which domains are event-sourced, which aren't; the criteria.
- `adr/0030-event-versioning.md` — the immutability rule, the v1/v2 widening pattern, the "events are forever" discipline.

---

## Definition of done

- [ ] Attendance domain event-sourced. `attendance_event` append-only with RLS.
- [ ] `MarkAttendanceUseCase` writes event + outbox in one transaction.
- [ ] Projector consumes from outbox, builds `attendance_daily_view`.
- [ ] Read API uses the projection; never queries events directly.
- [ ] Audit API exposes the raw event timeline.
- [ ] Projection rebuild tool works; verified by drop + rebuild = same state.
- [ ] Schema-evolution scenario: v2 event added, v1 events still project correctly.
- [ ] Cross-tenant test: events for tenant A don't leak into tenant B's projection.
- [ ] ADR-0029 (event sourcing where) and ADR-0030 (event versioning) written.

---

## Reflection questions

1. **Why is attendance event-sourced but `Student.firstName` is not?** Articulate the criteria.
2. **A teacher's correction event arrives 10 seconds after the projector's watermark. Walk through the path from event → updated view.**
3. **The projection is corrupt (a bug in the projector code). What's the recovery?**
4. **A v2 attendance event adds `excused`. A v1 client queries today's data. What does it see?**
5. **The CTO asks "why don't we just use Postgres rows like the rest of the system?" — write the 30-second answer.**

---

## References

- Greg Young, *Event Sourcing* talk — the canonical primer
- Martin Fowler, *Event Sourcing* article: <https://martinfowler.com/eaaDev/EventSourcing.html>
- Vaughn Vernon, *Implementing Domain-Driven Design* — chapter on event sourcing
- "What if we never stored state?" — various engineering blog posts
- Internal:
  - `docs/adr/0009-transactional-outbox-pattern.md` — the outbox we already have
  - `docs/adr/0011-saga-orchestration-vs-choreography.md` — sagas + event sourcing complement each other
