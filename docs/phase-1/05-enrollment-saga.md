# Phase 1.5 — First saga: Enrollment

> **Concepts:** distributed transactions and why 2PC fails for microservices, the saga pattern, orchestration vs choreography, durable saga state in Postgres, compensating actions, idempotency at the step level, retry budgets, saga visibility for operators
> **Estimated effort:** 3–4 weekends — this is the canonical hard problem
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 1.0–1.4 complete (RLS, registry, SIS, outbox + consumer)
> - Read [`../../documentation.md`](../../documentation.md) §3.3 (Sagas — the enrollment example)
> - Read Chris Richardson's *Saga* pattern article on `microservices.io` carefully — it's the most-cited primer

---

## What you'll learn

- Why **two-phase commit (2PC) is impractical** across microservices — the chains of locks, the coordinator failure modes, the participant-failure recovery procedures, and why production systems abandoned 2PC decades ago.
- The **saga pattern**: a sequence of local transactions, each of which has a *compensating* action that semantically undoes it. The system is eventually consistent and *always* recoverable.
- **Orchestration vs choreography**: when to centralize the workflow logic in one service (orchestration) and when to let services chain themselves via events (choreography). The senior tradeoff is well-known but hard to apply by feel.
- **Durable saga state**: how to persist the saga's progress in Postgres so a process crash mid-saga doesn't leave the system in a torn state.
- **Step idempotency**: every step must be safe to re-run. This is the hardest property to design for and the easiest to forget.
- **Compensation idempotency**: every compensation must be safe to re-run *and* must work when the step it's compensating only partially completed.
- **Retry budgets and dead-saga handling**: not every saga can finish; what's the policy?
- **Saga visibility**: operators need to see "this saga is at step 3 of 7, has failed twice on step 4, last error was X." Without that, debugging is forensic archaeology.

---

## Why this matters (senior perspective)

If RLS is the safety net (milestone 1.1), the saga is the **load-bearing column** of any non-trivial microservices system. Every cross-service workflow — enrollment, refunds, account closure, password reset with side effects, tenant promotion — is a saga whether you call it that or not. The choice is between *designing* the saga and *accidentally inventing* one badly under pressure.

The senior posture has three parts:

1. **Distributed transactions are not coming back.** Engineers occasionally suggest "let's use 2PC" because they've seen `XA` in a Java textbook. The honest answer: 2PC requires every participant to hold locks for the duration of the coordinator's protocol, the coordinator is a single point of failure, and partition tolerance is sacrificed. Production microservices abandoned this in ~2010. Don't relitigate.
2. **Eventual consistency is the contract.** The user-visible promise of a saga is "if you got the success response, all steps will eventually complete; if any step fails, the system will compensate to a coherent state." It is *not* "all steps appear atomic." This must be communicated in the API contract and to product stakeholders.
3. **Compensation is harder than steps.** Writing the happy-path workflow is easy. Writing the compensation that handles step-3-failed-but-step-2-already-published-an-event is the hard part. Every compensation must answer: "what state can the world be in when I run, and is my action correct in all of them?"

The fourth senior moment is **picking orchestration**. The original architecture document recommends orchestration over choreography for enrollment because:
- The steps have a strict order (you can't assign a section before the student exists).
- The workflow is a product surface (admins want to see "step 4 of 7 in progress").
- Rollback semantics need a single owner (one place to express "if step 5 fails, undo 1–4").
- Choreography spreads the workflow across services' subscribers, which is unauditable in code review.

Choreography has its place — high-fanout fire-and-forget events, where any single consumer's correctness is independent. Enrollment is the wrong shape for that. Defending the choice is in your ADR.

---

## Hands-on plan

### Step 1 — Generate the enrollment-service

1. `nx g @nx/nest:app enrollment-service` (or, if you prefer, place it as a module within `sis-service` initially — the doc's bounded-context rule allows starting as a module and splitting when justified). For learning purposes, **make it a separate service** so cross-service interactions are real.
2. Apply the clean-architecture layout from milestone 1.3.

### Step 2 — Define the saga state

A `SagaInstance` table is the durable state machine:

```
model SagaInstance {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String   @db.Uuid
  type         String                                  // "enrollment"
  status       String                                  // "running", "completed", "compensating", "compensated", "failed"
  currentStep  Int                                     // 0-indexed
  totalSteps   Int
  payload      Json                                    // input + accumulated step outputs
  lastError    Json?                                   // latest failure
  retryCount   Int      @default(0)
  startedAt    DateTime @default(now())
  completedAt  DateTime?

  steps        SagaStep[]

  @@index([status, startedAt])
}

model SagaStep {
  id              String  @id @default(uuid()) @db.Uuid
  sagaId          String  @db.Uuid
  stepIndex       Int
  name            String                                // e.g. "create-student"
  status          String                                // "pending", "running", "completed", "compensated", "failed"
  attempts        Int     @default(0)
  output          Json?                                 // captured output (e.g., the studentId)
  error           Json?
  startedAt       DateTime?
  completedAt     DateTime?
  compensatedAt   DateTime?

  saga            SagaInstance @relation(fields: [sagaId], references: [id])
  @@unique([sagaId, stepIndex])
}
```

Apply RLS to both tables.

The `SagaStep.output` field is critical: each step's compensation needs the data the step produced. If step 1 created a `studentId = X`, the compensation needs `X`. Capture it at the moment of success.

### Step 3 — Define the saga as code

A saga is a list of steps and their compensations. For enrollment:

```typescript
const EnrollmentSaga: SagaDefinition = [
  {
    name: 'create-student',
    execute: async (ctx) => sis.createStudent(ctx.input.studentInfo),
    compensate: async (ctx, output) => sis.softDeleteStudent(output.studentId),
  },
  {
    name: 'assign-to-section',
    execute: async (ctx) => academic.assignToSection(ctx.steps['create-student'].studentId, ctx.input.sectionId),
    compensate: async (ctx, output) => academic.removeFromSection(output.assignmentId),
  },
  {
    name: 'send-welcome-notification',
    execute: async (ctx) => notification.sendWelcome({ studentId: ctx.steps['create-student'].studentId, parentEmail: ctx.input.parentEmail }),
    compensate: async (ctx, output) => { /* notifications are fire-and-forget; no-op */ },
  },
];
```

Each step receives `ctx.steps[previousStepName]` to access the previous step's output. The `compensate` function receives the step's own captured output.

### Step 4 — Build the saga executor

The executor is a state machine driven by polling (or a queue). On each tick:

1. Find the next pending step for any running saga (`SagaInstance.status = 'running'`).
2. Execute the step. Record `attempts++`, `startedAt`.
3. On success: capture output, set step `status = 'completed'`, advance `SagaInstance.currentStep`. If last step, set saga status to `'completed'`.
4. On failure: increment retryCount; if under retry budget, leave for next tick; if over, transition saga to `'compensating'` and walk steps in reverse.
5. Compensation walk: for each step with `status = 'completed'` from current down to 0, run its compensate function. Mark each step `compensated`. When all done, saga status becomes `'compensated'`.
6. If a compensation itself fails: this is the worst case. Log loudly, alert humans, transition saga to `'failed'` (which now means "needs manual intervention"). Don't try forever.

Implement the executor as a worker process (like the outbox relay from milestone 1.4). Use BullMQ if you prefer queue semantics over polling.

**Locking:** like the outbox, use `FOR UPDATE SKIP LOCKED` to claim a saga for processing. Otherwise multiple workers race each other.

### Step 5 — Build the entry point

A controller endpoint:

```
POST /enrollments
{
  "studentInfo": { "firstName": "...", "lastName": "...", "dateOfBirth": "..." },
  "sectionId": "uuid",
  "parentEmail": "..."
}
→ 202 Accepted
{
  "enrollmentId": "uuid",
  "status": "running",
  "currentStep": 0,
  "_links": { "self": "/enrollments/<id>" }
}
```

Note: `202 Accepted`, not `201 Created`. The work is queued, not done. The contract is asynchronous.

A query endpoint:

```
GET /enrollments/:id
→ {
  "id": "...",
  "status": "running" | "completed" | "compensating" | "compensated" | "failed",
  "currentStep": 4,
  "totalSteps": 7,
  "steps": [
    { "name": "create-student", "status": "completed", "completedAt": "..." },
    { "name": "assign-to-section", "status": "completed", "completedAt": "..." },
    { "name": "send-welcome-notification", "status": "running", "attempts": 2, "lastError": "..." }
  ]
}
```

This is the operator surface. When something is wrong, this endpoint is the first thing checked.

### Step 6 — Step idempotency

Every saga step *will* be retried at some point (network blip, worker crash mid-step). The step must be idempotent.

Patterns:
- **Idempotency keys**: when calling `sis.createStudent`, pass `idempotencyKey: <sagaId>:<stepIndex>`. The SIS service checks if it's seen this key; if so, returns the prior result without creating a duplicate.
- **Natural deduplication**: if the step's effect is "set field X to value Y", running it twice is a no-op.
- **Output-based replay**: if the step has captured output, re-running it can detect the prior run by checking for the prior output (e.g., "does a student with this externalId already exist for this tenant?").

The simplest pattern: every cross-service call carries `Idempotency-Key: <sagaId>:<stepIndex>`. The receiving service stores it in a `processed_requests` table and returns the prior response on duplicate.

### Step 7 — Compensation idempotency and partial completion

A step that crashed mid-execution may have done part of its work. The compensation must handle the partial state.

Example: `assign-to-section` creates an assignment record AND publishes an event. If it crashed after creating the record but before publishing:
- Compensation: try to remove the assignment by `sagaId`+`stepIndex`. If found, remove. If not found (because the create never succeeded), no-op.
- The compensation should not fail just because the thing it's trying to undo doesn't exist.

The rule: **a compensation that runs twice should leave the system in the same state as if it ran once.**

### Step 8 — OTel: visualize the saga as one trace

Set the saga's root span at the entry point. Pass the trace context into each step. The saga ID is a span attribute. When you open the trace in Tempo, you see:

```
POST /enrollments (root)
└─ saga:enrollment (running on worker)
   ├─ step:create-student → SIS.createStudent → DB tx + outbox
   ├─ step:assign-to-section → academic.assign → DB tx
   └─ step:send-welcome → notification.publish → DB tx + outbox
```

If a step fails and compensation runs:

```
└─ saga:enrollment
   ├─ step:create-student → completed
   ├─ step:assign-to-section → FAILED (retry exhausted)
   ├─ compensate:create-student → SIS.softDelete
   └─ saga ended: compensated
```

This is the moment distributed tracing earns its keep beyond what milestone 1.4 demonstrated. A 7-step saga across 5 services, 12 minutes elapsed, retries everywhere — and one trace lays it out flat.

### Step 9 — Tests at the saga level

- **Happy path**: all steps succeed; saga ends `completed`; downstream side effects exist.
- **Step failure → compensation**: force a fault in step 3; verify compensations for steps 2 and 1 run; saga ends `compensated`; downstream side effects don't exist.
- **Idempotent re-execution**: rerun the same step on the same saga; verify the side effect happens once (the `Idempotency-Key` plumbing works).
- **Crash recovery**: kill the worker mid-step. Restart. Verify the saga resumes (the executor re-claims the saga and re-runs the in-flight step idempotently).
- **Compensation failure**: force the compensation of step 2 to fail; verify the saga transitions to `failed`, alerts fire, and the saga isn't retried indefinitely.
- **Concurrent sagas**: 100 sagas in flight at once; verify the worker pool processes them without deadlock or duplicate execution.

These are integration tests against a real database. They are slow. They are the right tests anyway.

### Step 10 — Write the ADRs

At least two:
- [`adr/0010-orchestration-vs-choreography.md`](../adr/) — defending orchestration for enrollment, with the conditions under which choreography would be correct.
- [`adr/0011-saga-state-storage.md`](../adr/) — Postgres state machine vs Temporal vs BullMQ flows; the conditions under which Phase 2 graduates to Temporal.

---

## Definition of done

- [ ] `enrollment-service` runs as a separate NestJS app.
- [ ] `SagaInstance` and `SagaStep` tables exist with RLS.
- [ ] `EnrollmentSaga` defined as a list of steps with execute + compensate functions.
- [ ] Worker process executes sagas; `FOR UPDATE SKIP LOCKED` prevents double-claim.
- [ ] `POST /enrollments` returns 202 with the saga ID; `GET /enrollments/:id` returns full state.
- [ ] Idempotency keys flow on cross-service calls; SIS and Academic return prior responses on duplicate.
- [ ] Compensation runs in reverse order on step failure; saga ends `compensated`.
- [ ] Compensation idempotent: running it twice leaves the same state.
- [ ] OTel trace shows entire saga as one logical workflow across services.
- [ ] All six test scenarios from step 9 pass.
- [ ] Metrics: saga success rate, average duration, p95 step duration, compensation rate.
- [ ] Cross-tenant test still passes — sagas for tenant A do not leak into tenant B.
- [ ] ADR-0010 (orchestration choice) and ADR-0011 (state storage) written.

---

## Common pitfalls

1. **Choreography for an ordered workflow.** When steps have a strict order, choreography means each consumer encodes the next-step trigger, which spreads the workflow logic across N services. Audit becomes impossible.
2. **In-memory saga state.** A worker crash mid-saga = lost state = orphaned side effects. State must be in Postgres.
3. **No retry budget.** The saga retries forever, building up an exponentially-growing pile of in-flight sagas. Set a budget and stick to it.
4. **Compensation that assumes the step fully completed.** If step 3 crashed mid-execution, the compensation must handle partial state, not throw because it can't find the thing to undo.
5. **No idempotency on cross-service calls.** Step retries create duplicates: two students, two section assignments, two welcome emails. The user-visible failure is "I got two emails."
6. **Idempotency keyed by aggregate ID alone.** A saga that failed and was rerun (same payload, new sagaId) would be falsely deduplicated. Key idempotency by `sagaId:stepIndex`, not by aggregate.
7. **Synchronous saga (block the HTTP request until done).** Sagas are async. The contract is "we'll do it"; the HTTP response is `202`, not `201`. Blocking violates this and produces user-visible timeouts.
8. **Saga visibility hidden in logs.** Operators need a query endpoint, not a Loki search. Build the `GET /enrollments/:id` endpoint as a first-class part of the saga.
9. **Mixing business state and saga state.** `Student.enrollmentSagaStatus` is a smell. The saga state is the saga's; the entity has its own state.
10. **Trying to make sagas "look like" transactions.** They aren't. Leaning into the eventual consistency is the only honest design.

---

## Stretch goals (optional rabbit holes)

- **Replace the polling executor with Temporal.** Compare developer experience: workflow-as-code, automatic retries, durable history. Note the operational cost: Temporal is a non-trivial operator.
- **Implement parallel steps.** Some saga DAGs have steps that can run concurrently (e.g., generate welcome PDF + send email in parallel after student creation). Refactor `SagaDefinition` to support a DAG, not just a list.
- **Add timeouts per step.** A step stuck for 1 hour should trigger compensation, not block the saga forever. Implement step-level deadlines.
- **Build a saga visualization endpoint** that returns a state diagram (e.g., DOT format) of the current saga's progress. Operators love these.
- **Implement saga replay**: given a `compensated` saga, an admin can replay it from any step (correcting whatever caused the original failure). Requires careful idempotency thinking.
- **Read the original sagas paper** (Garcia-Molina & Salem, 1987). 40 years old, still relevant.
- **Read the Uber Cadence/Temporal write-ups** on long-running workflows. Cadence is Temporal's predecessor; the design rationale is the same.

---

## Reflection questions

1. **Why is two-phase commit unsuitable for microservices?** Walk through the failure modes (coordinator failure, participant failure, partition).
2. **Which steps in your enrollment saga are *not* compensable?** (Hint: an email sent cannot be unsent. What's the right design when this happens at step 7 of 7?)
3. **You picked orchestration. Under what conditions would choreography be correct instead?** Articulate the test you'd apply.
4. **A worker crashed mid-step. Walk through what happens when the saga executor restarts.** What guarantees does your idempotency provide that prevent duplicate effects?
5. **Compensation of step 2 failed. The saga is now in a torn state. What's your operator response?** Is there a runbook?
6. **The saga has run 100,000 times. Your `SagaInstance` table is enormous. What's your retention policy?**
7. **A new step needs to be added between current steps 3 and 4. Some sagas are mid-flight when the deploy happens. What strategy lets in-flight sagas finish on the old version while new sagas use the new version?**

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §3.3 (Sagas).
- **Chris Richardson, `microservices.io`:** *Saga* pattern (the canonical primer), *Process Manager*.
- **Hector Garcia-Molina & Kenneth Salem, *Sagas* (1987):** the original paper.
- **Uber Engineering blog:** *Cadence* / *Temporal* posts — design rationale for durable workflow systems.
- **Temporal documentation:** even if you don't use it, the conceptual content (workflows vs activities, retries, idempotency) is excellent.
- **Caitie McCaffrey, *Distributed Sagas*** (talk at QCon).

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.5 to `Done`. Move to milestone 1.6 (IAM with Keycloak). The hand-rolled JWT you've been carrying since milestone 1.1 is about to be replaced with the real thing.
