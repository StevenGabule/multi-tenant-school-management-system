# ADR-0012: Saga state in Postgres (with explicit graduation triggers to Temporal)

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

ADR-0011 commits us to orchestrated sagas. The orchestrator must persist
state durably — a worker crash mid-saga without persistent state means
torn workflow state, orphaned side effects, and unrecoverable systems.

The substrate for that state is the question. Three reasonable choices
exist in 2026:

1. **Postgres tables** — `saga_instance` + `saga_step`, polled by a
   worker. Same Postgres cluster the application already runs on.
2. **BullMQ on Redis** — job queue with retries, scheduling, and
   first-class observability via the BullMQ dashboard.
3. **Temporal / Cadence** — a dedicated workflow engine with durable
   workflow execution, automatic retries, versioning, deterministic
   replay, and a UI.

Each is correct for *some* phase of a project's growth. Picking the
wrong one is expensive: Postgres tables sized for 100 sagas/day collapse
under 100k/day; Temporal at 100 sagas/day is operational overkill that
nobody on the team understands.

## Decision

**Phase 1 stores saga state in Postgres tables (`saga_instance`,
`saga_step`) under RLS, polled by an in-process worker. This ADR
records the explicit triggers that flip us to Temporal in Phase 2; if
none of those fire, we stay on Postgres.**

### Specific rules (Phase 1)

1. **Two tables, both tenant-scoped under RLS+FORCE.** `saga_instance`
   holds the high-level state machine (status, currentStep, retryCount,
   payload). `saga_step` holds per-step rows with `output` captured at
   success time (compensations read this back). The migration is in
   `apps/enrollment-service/prisma/migrations/.../init/migration.sql`.

2. **The executor connects via `sms_app` (BYPASSRLS).** Same pattern
   as the outbox relay (ADR-0009). Necessary because the executor scans
   ALL tenants' running sagas in one query; FORCE RLS on the saga
   tables would block that. Application code (POST /enrollments)
   writes via app_user with RLS enforced.

3. **`FOR UPDATE SKIP LOCKED` for multi-replica safety.** The executor
   claims one saga per tick. Multiple replicas (when we deploy them)
   each claim a different row; no leader election, no coordinator,
   no Zookeeper.

4. **One step per tick, forward AND backward.** Symmetric. The retry
   budget × tick interval × step count bounds worst-case saga duration
   in a way that's easy to reason about.

5. **The tx STAYS OPEN through the cross-service HTTP call.** Holds the
   saga row lock for the duration of the step. Trade-off: simpler
   crash recovery (next tick re-claims the saga in its prior state).
   Cost: long-held locks reduce per-replica throughput. Acceptable for
   Phase 1 single-replica; revisited at Phase 2 scale.

6. **Tick interval = 1s. Polling, not event-driven.** Future ticks could
   be triggered by NOTIFY (saga inserted → wake the executor) but the
   1s polling baseline is cheap and predictable.

### Phase 2 graduation triggers — when we move to Temporal

We commit to Temporal migration when ANY of these become true:

  1. **Workflow versioning becomes painful.** We deploy a saga with a
     new step inserted in the middle, and in-flight sagas break. ADR-0011
     mitigates this with "append-only" rules; if those break down (real
     business reasons demand middle-inserts), we need real workflow
     versioning. Temporal's `Workflow.GetVersion` is the standard solution.
  2. **We need wall-clock timers that cross worker restarts.** "If
     payment hasn't cleared in 24 hours, cancel the saga." Today this
     is a future-tick check; at scale and with strict SLAs, Temporal's
     timer service is more reliable.
  3. **Workflow throughput exceeds ~100 sagas/sec.** The current single-
     replica polling pattern caps at ~1 saga/tick × 1s tick = 1
     saga/replica/sec. Multi-replica scales linearly to ~100 — past
     that, the polling pattern + DB lock contention dominate.
  4. **Cross-saga visibility / DAGs.** Saga A waits for saga B to
     complete. Saga A and saga B share state. We can build this on
     Postgres but Temporal does it natively, with first-class signaling.
  5. **The workflow definition shape becomes complex** (DAG with
     parallel steps, branching based on step outputs). Today's
     `readonly steps[]` is sufficient; richer shapes warrant a richer
     framework.

If NONE of the above trigger by milestone 2.0 review, we stay on
Postgres + polling. The migration is non-trivial and must pay back.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Postgres tables (chosen)** | No new infrastructure; saga state is queryable with `psql`; FOR UPDATE SKIP LOCKED gives multi-replica safety for free; saga state lives in the same cluster as the application data, so audits are joins; matches the operational pattern of the outbox relay | Polling has a 1s latency floor; long-held locks reduce throughput; no built-in workflow versioning; manual implementation of timers, retries, replay | n/a — perfect for Phase 1 |
| **BullMQ on Redis** | Battle-tested job queue; rich dashboard; first-class retry policies; lower-latency than DB polling | Redis is already in the stack (cache layer); using it for primary saga state mixes concerns and complicates DR; "queue" semantics fit poorly for stateful workflows that need to read prior step outputs | Redis is the wrong durability tier for primary saga state; cache-only Redis is what we have today |
| **Temporal** | Industry standard; workflow-as-code; durable history; deterministic replay; rich versioning; first-class signaling; UI; managed offering exists (Temporal Cloud) | Operational cost (Temporal cluster + DB + UI) outsized for Phase 1; learning curve; one more service to operate; deterministic constraint on workflow code is unfamiliar in TypeScript | Right answer at scale; explicit graduation triggers above |
| **Cadence (Uber's predecessor to Temporal)** | Same as Temporal — they're sibling projects | Smaller community in 2026; Temporal is the active fork | Not the active project; reach for Temporal if we move |
| **In-memory state machine (a la XState) with periodic checkpoint to DB** | Less SQL; richer state-machine vocabulary | Same durability story as DB polling but more code; recovery semantics are hand-rolled per-saga | Costs more than it returns at this scale |

## Consequences

**Positive:**

- Zero new infrastructure. Postgres + the existing Nx app pattern is
  enough. The migration applies cleanly via the existing
  `pnpm prisma:enrollment-service:migrate` flow.
- Saga state is queryable and inspectable. `SELECT * FROM
  saga_instance WHERE status='compensating'` is the operator's
  diagnostic. With Temporal, the equivalent is "log into the UI" — fine,
  but a higher-friction debug path.
- The pattern matches the outbox relay (ADR-0009), so engineers who
  understand one immediately understand the other. Single mental model
  for "polling worker that drains a queue under FOR UPDATE SKIP LOCKED."
- Tests are simple. The integration test creates a saga, calls
  `executor.tick()` directly, asserts state. No external dependency.

**Negative / costs:**

- We hand-roll retries, timers, versioning. Each comes with subtle
  failure modes. STEP_RETRY_BUDGET=3 is a constant in code; Temporal
  would let it be a workflow attribute with policies (exponential
  backoff, jitter, etc.).
- The single-replica long-tx-hold pattern caps throughput. At Phase 2
  this becomes the first thing to fix.
- No workflow versioning means in-flight sagas + a deploy with new
  steps is a manual coordination problem. ADR-0011 records the rule
  ("append-only steps") and this ADR records the trigger that flips
  the decision when the rule breaks down.

**Risks:**

- A future engineer adds an in-memory state field to `SagaExecutor` for
  performance — torn state on crash. Mitigation: code review + this
  ADR linked from the executor.
- The retry budget is tight (3). A flaky downstream might exhaust the
  budget on transient failures and trigger false compensation, which
  costs *real* work (e.g., a created student gets soft-deleted because
  of a 30-second academic-service blip). Mitigation: the budget is a
  knob; if false-compensation incidents accumulate, raise it. (3 was
  chosen because that's where the docs and a senior friend's QCon talk
  agreed.)
- `saga_instance` table grows unbounded. Cleanup job is Phase 2, same
  as the outbox cleanup. With ~1k completed sagas/month the table is
  tiny; review at the 100k mark.

**Follow-up work this enables / forces:**

- The current SagaExecutor accepts `EnrollmentSaga` directly in its
  constructor. A future second saga (refund, password reset) requires a
  saga *registry* — the executor looks up the SagaDefinition by `type`
  string. Trivially done; the constraint today is just that we have one
  saga.
- Phase 2 ESLint rule: any code that mutates `saga_instance` outside
  the executor is rejected. The executor is the single writer.
- Phase 2 metrics: saga p95 duration, compensation rate, retry-budget-
  exhaustion rate, executor lag (oldest-running-saga age). The lag
  metric is the analog of outbox lag — the single most-important signal.

## References

- Temporal documentation, especially:
  - `docs.temporal.io/concepts/what-is-a-workflow` — the conceptual model
  - `docs.temporal.io/dev-guide/typescript/versioning` — the versioning
    primitives we'd need if we migrate
- Caitie McCaffrey's *Distributed Sagas* talk (QCon) — the case study
  that crystallized "saga state must be durable, must support replay."
- BullMQ docs — for completeness on the option we considered.
- Internal:
  - `apps/enrollment-service/prisma/schema.prisma` — `SagaInstance` +
    `SagaStep` models
  - `apps/enrollment-service/src/sagas/saga.executor.ts` — the polling
    worker
- Phase 1.5 milestone: [`../phase-1/05-enrollment-saga.md`](../phase-1/05-enrollment-saga.md)
- Related: [ADR-0009](0009-transactional-outbox-pattern.md) (the
  outbox-relay polling pattern this saga executor mirrors)
- Related: [ADR-0011](0011-saga-orchestration-vs-choreography.md) (the
  pattern this state storage supports)
