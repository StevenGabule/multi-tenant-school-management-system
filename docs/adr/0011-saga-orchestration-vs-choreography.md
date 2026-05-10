# ADR-0011: Orchestration (not choreography) for the enrollment saga

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Milestone 1.5 introduces the first cross-service workflow that isn't a
single event-driven side effect: *enrollment*. The workflow is

  1. Create a student in sis-service.
  2. Confirm the enrollment in academic-service (assign to a class).
  3. (Future) Send a welcome notification.

If any step fails, the system needs to roll back to a coherent state. A
student row without an enrollment row is wrong. An enrollment without a
student is wrong. We *cannot* use a database transaction — sis-service
and academic-service own different databases (`sms_sis`, `sms_academic`).
2PC is dead (ADR-0009 background).

Two valid patterns exist for cross-service workflows under eventual
consistency:

- **Choreography.** Each service emits domain events; downstream
  services subscribe and chain themselves. The "workflow" is implicit
  in the topology of subscribers.
- **Orchestration.** A central component (the orchestrator) calls each
  step explicitly, persists the workflow state, and decides when to
  compensate. The workflow is a thing — a `SagaDefinition` — that lives
  in code.

The choice is consequential. Re-doing it costs weeks because every
downstream service is wired one way or the other.

## Decision

**Orchestration. The enrollment-service hosts a SagaExecutor that drives
each step explicitly via HTTP, persists per-step state in
`saga_instance` / `saga_step`, and runs compensations in reverse on
terminal step failure.**

We adopt orchestration as the *default* for any future cross-service
workflow that meets the criteria below. Choreography stays in the toolkit
for pure-broadcast cases (see "When choreography wins" below).

### Specific rules

1. **One orchestrator per workflow type.** enrollment-service owns the
   enrollment saga. tenant-promotion (future) gets its own service or
   becomes a saga *type* within an existing service. We don't combine
   workflows that have unrelated business logic into one orchestrator
   for "DRY" reasons.

2. **Steps are HTTP calls.** The orchestrator and the receiving service
   are decoupled by HTTP, not by an event broker. Choosing HTTP (vs.
   command-events) for orchestrator-driven steps means:
     - Synchronous backpressure (the orchestrator sees latency directly)
     - Easier debugging (step result is the HTTP response; no broker
       inspection needed)
     - Idempotency-Key as a first-class header (the standard pattern)
   Phase 2 may switch to command-events for high-throughput sagas;
   Phase 1 sticks with HTTP for clarity.

3. **State lives in Postgres** (`saga_instance`, `saga_step`). No in-
   memory state machine. A worker crash mid-saga must be recoverable.
   See ADR-0012.

4. **Compensation is the saga's job.** The orchestrator is the only
   place that knows "if step 3 fails, undo 1 + 2 in this order."
   Receivers don't know about the saga; they just expose idempotent
   forward + reverse endpoints.

5. **The saga's contract to its caller is `202 Accepted` + a polling
   endpoint.** Eventual consistency is communicated, not hidden. The
   `GET /api/enrollments/:id` endpoint is the operator surface — the
   first thing reached for when something is wedged.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Choreography (chain via outbox events)** | No new orchestrator service; reuses milestone 1.4's event substrate; service autonomy is maximal | Workflow logic is spread across N subscribers; no single place expresses "step 3 failed → undo 2 + 1"; compensation is exceptionally hard (each downstream service needs to listen for failure events emitted by *some other* service); audit/debug story is "grep across N services for the events" | Doesn't fit ordered workflows with rollback |
| **Choreography with explicit failure events** | A bit more structure than naive choreography | The orchestration logic is still distributed — just disguised. "If step 3 fails, undo 2" lives in service-2's "step-3-failed" handler; debugging is no easier than vanilla choreography | The structure doesn't move the dial enough |
| **Centralized orchestrator (chosen)** | Workflow is a thing in code (`SagaDefinition`); compensation lives in one place; operator endpoint shows full state; testable as a unit | Orchestrator is a coupling point — it knows the names of the steps and their endpoints; orchestrator failures block the whole workflow; one more service to operate | n/a — fits the workflow shape exactly |
| **Temporal / Cadence** | Best-in-class workflow engine; durable history; rich retry policies; workflow-as-code | Operational cost (Temporal cluster + UI); schema for workflow versioning needs care; we'd be the only service using Temporal in Phase 1 — no shared expertise yet | Right answer at scale; ADR-0012 records the conditions for graduating |

### When choreography wins (and we use it later)

Choreography is the right pattern for **broadcast fan-out where each
consumer's correctness is independent**:

- "student.created → invalidate caches in 6 services" — each cache
  is independent; no rollback needed; choreography is fine.
- "tenant.invalidated → flush local LRU + Redis pubsub fan-out" —
  same pattern; no orchestration value.
- "audit.log.created → ship to s3 + ship to splunk + index in OpenSearch"
  — each downstream is independent.

Phase 1.4's outbox + event consumer already implemented this pattern
(student.created → enrollment_slot in academic). That's choreography,
and it's correct for that case. The two patterns coexist:
  - Choreography: fire-and-forget broadcasts, no rollback
  - Orchestration: ordered workflows, rollback semantics

## Consequences

**Positive:**

- The enrollment saga's logic is in *one* file (`enrollment.saga.ts`).
  A reader can audit the workflow in 50 lines: 2 steps, each with an
  `execute` + `compensate`. Compare to choreography where the logic is
  scattered across 3+ subscriber methods in different services.
- The compensation walk is rigorous: highest-completed step compensates
  first, working backward. Every saga-instance row has a complete audit
  trail in `saga_step` showing what happened and when.
- The operator endpoint (`GET /api/enrollments/:id`) is a first-class
  product feature, not an afterthought. Admins see "step 2 has failed
  twice with this error" without filing a ticket against engineering.
- Phase 2 migration to Temporal (if triggered — see ADR-0012) is
  *additive*: the SagaDefinition shape maps to Temporal workflows
  cleanly. We don't have to relitigate the pattern.

**Negative / costs:**

- The orchestrator is a *new service* (enrollment-service). One more
  thing to deploy, monitor, and run. For Phase 1's small footprint this
  is barely material; at scale it's a real cost vs. choreography's
  zero-marginal-cost-per-workflow.
- The orchestrator knows about the receivers' endpoint contracts.
  Adding a step in the middle of an existing saga requires (a) deploying
  the new endpoint on the receiver, (b) deploying the orchestrator with
  the new step in the right position, AND (c) handling in-flight sagas
  (see "Risks").
- Synchronous HTTP from the orchestrator means receiver latency is
  borne by the orchestrator's tx (we hold the saga row lock during the
  step — see SagaExecutor design notes). At Phase 2 throughput this
  needs revisiting; documented as a known trade-off in code.

**Risks:**

- **In-flight sagas during a deploy with a new step.** A saga started
  pre-deploy thinks `totalSteps=2`; the new code says `totalSteps=3`. If
  not handled, sagas complete one step short of the new workflow.
  Mitigation: `totalSteps` is captured at saga creation time (it is —
  see `SagaInstance.totalSteps`); the executor uses the saga's stored
  `totalSteps`, not the live count from `EnrollmentSaga.steps.length`.
  Wait — we *don't* currently store the step *names*; the executor
  resolves step `currentStep` by index against `EnrollmentSaga.steps`
  at runtime. Adding a step in the middle would shift indices of later
  steps — breaking in-flight sagas. **Mitigation:** add new steps at
  the END only (an immediate-future-engineer rule); for middle inserts,
  drain in-flight sagas before deploying. Phase 2 may version the saga
  definition itself.
- **Orchestrator availability.** If enrollment-service is down, no new
  enrollments can start AND in-flight sagas don't progress. Mitigation:
  saga state is durable; the executor resumes on restart. For Phase 1
  this is acceptable; Phase 2 sizing should account for it.
- **Mismatch between orchestrator and receiver versions.** If the
  receiver changes the response shape, the orchestrator's parsing
  breaks. Mitigation: versioned API contracts; integration tests that
  hit real services.

**Follow-up work this enables / forces:**

- Future sagas (refund, account closure, password reset with side
  effects) reuse the SagaExecutor pattern. The generic `SagaDefinition`
  + `StepDefinition` types in `saga-definition.ts` are the framework.
- The choreography path (event consumer) and the orchestration path
  (saga executor) coexist. The two patterns are not in conflict — they
  serve different workflow shapes. The repo's mental model: events for
  fan-out, sagas for ordered workflows with rollback.
- Phase 2 may extract a shared `libs/saga-toolkit` if a second saga
  ships outside enrollment-service. Today the SagaExecutor is internal.

## References

- Chris Richardson, *Microservices Patterns* (2018), chapter 4 — the
  canonical primer; orchestration vs choreography is fully laid out.
- Garcia-Molina & Salem, "Sagas" (1987) — the original. Still relevant
  for the compensation theory.
- Bernd Rücker, "*The Microservices Workflow Automation Cheat Sheet*" —
  pragmatic decision guide; recommends orchestration for everything
  with > 3 steps or any rollback semantics.
- Internal:
  - `apps/enrollment-service/src/sagas/saga-definition.ts` — the
    generic types
  - `apps/enrollment-service/src/sagas/enrollment.saga.ts` — the
    canonical SagaDefinition implementation
  - `apps/enrollment-service/src/sagas/saga.executor.ts` — the
    polling worker
- Phase 1.5 milestone: [`../phase-1/05-enrollment-saga.md`](../phase-1/05-enrollment-saga.md)
- Related: [ADR-0009](0009-transactional-outbox-pattern.md) (the event
  pattern that complements orchestration)
- Related: [ADR-0012](0012-saga-state-storage.md) (where the saga state
  lives and when it graduates)
