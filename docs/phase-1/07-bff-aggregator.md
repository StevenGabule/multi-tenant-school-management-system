# Phase 1.7 — BFF as JSON aggregator

> **Concepts:** Backend-for-Frontend (BFF) pattern, persona-specific aggregation, contract testing, REST vs GraphQL at the BFF, latency stacking and parallelism, BFF-layer caching, defense-in-depth authorization (BFF + service + RLS)
> **Estimated effort:** 2 weekends (no frontend, so the work is API design and integration)
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 1.0–1.6 complete (IAM works, services emit events, sagas run)
> - Read [`../../documentation.md`](../../documentation.md) §3.4 (API Gateway, BFFs, inter-service auth) and §8 (REST vs GraphQL Federation guidance)
> - Read Sam Newman's *Pattern: Backends For Frontends* — `samnewman.io/patterns/architectural/bff/`

---

## What you'll learn

- The **BFF pattern** as Sam Newman articulates it: one backend per persona/client, owned by the team that owns the client, optimized for the client's needs rather than the underlying services' shapes.
- Why a BFF is **not** an API gateway — gateways do cross-cutting concerns (auth, rate limit, routing); BFFs do persona-specific aggregation and shaping.
- How to design **persona-shaped endpoints** (`GET /me/dashboard`, `GET /me/notifications`) that return exactly what one screen needs, no more, no less.
- **Latency stacking**: when you call three services sequentially, your latency is the sum; when you parallelize with `Promise.all`, it's the max. The math is trivial; getting the parallelism right requires care (some calls genuinely depend on prior results).
- **Contract testing** with Pact (or similar): how the BFF and the services it calls keep their schema agreement enforceable across team/repo boundaries.
- **BFF-layer caching** with versioned keys: when caching is correct, when it leaks data, and how to scope cache keys by tenant + user + resource version.
- **Defense in depth**: the BFF enforces authorization, the service re-enforces, and RLS is the floor. Three layers, each independently sufficient — and each one a backstop when another fails.
- The **GraphQL Federation** option: when it earns its keep at the BFF (multiple persona BFFs, schema churn) and when REST is the better choice (you have one or two BFFs and stable contracts).

---

## Why this matters (senior perspective)

Without a BFF, frontends talk to services directly. The shape of the failure that follows is predictable:

- The frontend orchestrates 4 service calls per screen render. Latency adds up. Mobile users on poor networks rage-quit.
- The frontend re-implements authorization rules ("if I'm a parent, hide the discipline tab"). The rules drift between iOS, Android, and web.
- A change in one service's response shape breaks all clients simultaneously. Coordinated deploys become required, which is the antithesis of microservices.
- The mobile team cannot move faster than the slowest backend team to ship a screen change.

The BFF is the answer Phil Calçado articulated and Sam Newman codified: **one persona, one BFF, owned by the client team**. A change to the parent-portal screen means a change to `bff-parent` only — the underlying SIS service doesn't need to know.

The senior posture has three parts:

1. **The BFF is for the client, not for "all clients."** A "shared API for parent web + parent mobile" is *not* a BFF — it's a shared service. The BFF pattern's value comes from being free to optimize for one persona's exact needs.
2. **The BFF tax is real.** Each call adds latency; each layer adds operational surface; each contract introduces drift risk. Without contract tests and budgets (latency, error rate), the BFF tax compounds and the architecture rots.
3. **Authorization belongs at every layer.** The BFF is *not* the only enforcer. If a malicious actor bypasses the BFF (via a leaked service URL, a misconfigured network policy, an internal endpoint exposure), the service must still refuse. RLS is the database floor. Three layers; each independent.

The fourth senior moment is **resisting GraphQL Federation on day one**. The original architecture document says it explicitly: *"Don't introduce federation on day one; it requires schema governance discipline most early teams lack."* For your learning project: feel REST aggregation first. Notice what hurts. *Then* consider whether GraphQL Federation would have hurt less. The doc lists "Khan Academy / Netflix / Expedia all use this pattern" — but those teams arrived at federation after years of REST + custom aggregation, not before.

---

## Hands-on plan

### Step 1 — Generate `bff-parent`

1. `nx g @nx/nest:app bff-parent`. Apply the clean-architecture layout.
2. The BFF speaks **two languages**:
   - **External** — REST + JSON to the (eventual) parent client. OpenAPI documented.
   - **Internal** — to SIS, Academic, Notification. For Phase 1, use HTTP/REST internally too (gRPC is a Phase 2 concern; the doc says so).
3. The BFF does **not** own a database. It composes from services. The exception is a small Redis cache for response caching.

### Step 2 — Design the persona-shaped endpoints

A parent's primary screen is "today" — what's happening with their children today. The endpoint:

```
GET /me/dashboard
Authorization: Bearer <parent JWT>

→ {
  "children": [
    {
      "id": "...", "firstName": "...", "lastName": "...", "grade": "5",
      "todayClasses": [
        { "subject": "Math", "period": 1, "teacher": "Ms. Smith", "room": "204" },
        ...
      ],
      "recentGrades": [
        { "assignment": "Quiz 3", "score": 87, "outOf": 100, "subject": "Math", "date": "..." },
        ...
      ],
      "openNotifications": 2
    },
    ...
  ],
  "announcements": [
    { "title": "Snow day Friday", "publishedAt": "..." }
  ]
}
```

This response combines data from SIS (`children`), Academic (`todayClasses`, `recentGrades`), Communications (`announcements`), Notification (`openNotifications`).

A naive sequential implementation:

```typescript
const children = await sis.getChildrenForParent(userId);
for (const child of children) {
  child.todayClasses = await academic.getClassesFor(child.id, today);
  child.recentGrades = await academic.getRecentGradesFor(child.id);
  child.openNotifications = await notification.countUnreadFor(child.id);
}
const announcements = await communications.getRecentAnnouncements(tenantId);
```

For 3 children and 4 calls each, that's 13 sequential calls. At 50ms each, the response takes 650ms. Unacceptable.

### Step 3 — Parallelism: `Promise.all` carefully

Refactor for parallelism:

```typescript
const [children, announcements] = await Promise.all([
  sis.getChildrenForParent(userId),
  communications.getRecentAnnouncements(tenantId),
]);
const enriched = await Promise.all(
  children.map(async child => ({
    ...child,
    ...(await Promise.all([
      academic.getClassesFor(child.id, today),
      academic.getRecentGradesFor(child.id),
      notification.countUnreadFor(child.id),
    ]).then(([classes, grades, notifs]) => ({
      todayClasses: classes,
      recentGrades: grades,
      openNotifications: notifs,
    }))),
  }))
);
```

Now the latency is `max(initial calls) + max(per-child enrichment)` ≈ 100ms instead of 650ms. The parallelism math is the lever.

**Subtlety**: parallelism requires independent calls. If call B needs the result of A, you can't parallelize them. Map dependencies before optimizing.

### Step 4 — BFF-layer authorization

Every endpoint enforces "parent of children whose data is being read":

1. The BFF receives the parent's JWT; extracts `userId` and `tenantId`.
2. It calls `sis.getChildrenForParent(userId)` — this returns only the parent's own children (SIS enforces via the ABAC + RLS from milestone 1.6).
3. All subsequent calls are scoped by those child IDs. The parent cannot pass arbitrary child IDs because the BFF derives them from the authenticated parent.

If the BFF accepts a `?childId=` query param, *every* such param must be re-checked against the parent's authorized children. Resist clever optimizations that "trust" the param.

Defense in depth: the underlying services still re-check. RLS still re-checks. The BFF is the first wall, not the only wall.

### Step 5 — Caching with versioned keys

Caching the dashboard response saves backend load on a refresh-heavy endpoint. The cache key:

```
bff:parent:dashboard:{tenantId}:{userId}:{day}:{etag}
```

- `tenantId` and `userId` scope the cache to the actor.
- `day` ensures the cache invalidates at midnight (today's data changes daily).
- `etag` is a content hash — used for `If-None-Match` 304 responses to clients.

TTL: short (30–60 seconds). The dashboard is allowed to be slightly stale; the user can refresh.

**Critical correctness rule**: never cache authorization-sensitive data without the actor in the cache key. A parent A's cached response served to parent B is exactly the data leak you don't want.

For events that should bust the cache — a new grade is published — subscribe to the relevant event topic from milestone 1.4 and invalidate the cache for the affected child's parent.

### Step 6 — Contract testing with Pact (or alternative)

Pact is the industry-standard consumer-driven contract testing tool. The shape:

1. The consumer (BFF) writes tests describing what it expects from the provider (SIS).
2. Pact records these expectations as a "pact file."
3. The provider (SIS) verifies the pact in its own CI — it stands itself up and replays the consumer's expectations.
4. If SIS makes a breaking change, the pact verification fails *in SIS's PR*, before it merges.

Without contract tests, breaking changes in services are caught at integration time (or production). With them, breaking changes are caught at the moment of writing.

For Phase 1, set up Pact between `bff-parent` and one service (e.g., SIS). Document the workflow. Expand to the others as a stretch goal.

Alternative: schema-first with shared OpenAPI specs and `oasdiff` in CI to detect breaking changes. Less rigorous than Pact but lower setup cost.

### Step 7 — Latency budget and observability

Define the latency SLO for the BFF: e.g., p99 < 500ms for `GET /me/dashboard`.

Instrument the BFF with OTel to record per-call latency for each downstream service. The dashboard panel from milestone 1.8 will show the breakdown: gateway 5ms, BFF 80ms, SIS 30ms, Academic 50ms, Notification 20ms, Communications 25ms. When the SLO is breached, the breakdown tells you which hop to fix.

Implement a **per-request timeout budget**: the BFF has 500ms total. If SIS takes 300ms, the BFF only has 200ms left for everything else. Express this as per-call timeouts that decrement.

### Step 8 — Failure modes: BFF resilience

The BFF depends on multiple services. Any one being slow degrades the BFF. Patterns:

- **Timeouts on every call** — never block forever.
- **Circuit breakers** — after N consecutive failures, stop calling for a window. Fall back to cached or partial responses.
- **Partial responses** — if `notification.countUnreadFor` fails, the dashboard renders without the notification count. The user sees a degraded experience, not a 500.

Use `nestjs-resilience` or `cockatiel` for circuit breaker / retry primitives. Alternatively, when you adopt a service mesh in Phase 2, these become infrastructure concerns.

### Step 9 — A second BFF for contrast (optional but recommended)

Build `bff-admin` for school administrators. Note how different the persona-shaped endpoints become:

- `GET /admin/dashboard` is school-wide stats: enrollment count, attendance rate today, recent incidents.
- `GET /admin/students/:id` is a deep dive on one student — demographics, grades, attendance, discipline, parent contacts.

The BFF endpoints diverge dramatically from `bff-parent`. The same underlying services answer; the shape is persona-specific.

This is the moment "BFF per persona" stops feeling like overhead and starts feeling like the right thing.

### Step 10 — Tests

- **Authorization**: parent A's JWT cannot access parent B's children's data via `/me/dashboard`. Test the endpoint and bypass attempts (e.g., `?childId=<other-parents-child>`).
- **Latency**: a load test (k6) hitting `/me/dashboard` at 50 RPS produces p99 within budget.
- **Resilience**: kill the SIS service; assert the BFF returns a graceful degraded response, not a 500.
- **Cache correctness**: parent A's cached response is never served to parent B (manually verified via cache key inspection).
- **Pact**: a breaking change in SIS (rename a field) fails SIS's CI before it ships.

### Step 11 — Write the ADRs

At least two:
- [`adr/0014-bff-pattern.md`](../adr/) — defending BFF per persona vs shared API; the conditions under which a shared API would be correct.
- [`adr/0015-rest-vs-graphql-bff.md`](../adr/) — REST + JSON for Phase 1 BFF, with explicit conditions under which GraphQL Federation graduates in Phase 3.

---

## Definition of done

- [ ] `bff-parent` runs as a separate NestJS app.
- [ ] `GET /me/dashboard` aggregates from SIS + Academic + Notification + Communications.
- [ ] Parallelism via `Promise.all`; latency budgeted and measured.
- [ ] BFF enforces authorization (parent of children); services + RLS enforce again (defense in depth).
- [ ] Versioned, tenant+user-keyed Redis cache; TTL 30–60s; cache busts on relevant events.
- [ ] Contract tests (Pact) wired up between `bff-parent` and at least one service; breaking changes caught in service CI.
- [ ] OTel instrumented; per-call latency visible in trace.
- [ ] Resilience patterns: timeouts, circuit breakers, partial responses on dependency failure.
- [ ] Authorization tests: parent A cannot see parent B's data even with `?childId=` injection attempts.
- [ ] Latency SLO defined (p99 < 500ms); load test confirms it under 50 RPS.
- [ ] (Optional but recommended) `bff-admin` exists; demonstrates persona divergence.
- [ ] Cross-tenant test extended to BFF endpoints.
- [ ] ADR-0014 (BFF pattern) and ADR-0015 (REST vs GraphQL) written.

---

## Common pitfalls

1. **BFF as a shared API.** "One BFF for parent web + parent mobile + admin web." This isn't a BFF — it's a service. The pattern's value is per-persona optimization.
2. **Sequential calls when parallelism is possible.** Latency adds up linearly. Map dependencies, parallelize the independent ones.
3. **Caching authorization-scoped responses without the actor in the key.** Parent A's cached dashboard served to parent B = breach.
4. **Trusting query parameters for resource IDs.** A parent can pass `?childId=<arbitrary>` if the BFF doesn't re-check. Always derive scope from authenticated identity.
5. **No timeouts.** A slow service hangs the BFF, which hangs the user. Every call needs a per-call deadline.
6. **No contract tests.** Schema drift between BFF and services is a silent rot. Catch it at PR time, not at integration time.
7. **BFF doing business logic.** Aggregation and shaping, yes. Computing GPAs, no. Move computation to the owning service.
8. **No partial response strategy.** A 500 because the notification service blipped is a poor user experience. Render the rest; mark the failed section.
9. **Logging full responses.** PII flows through the BFF; logs catch it. Apply the same redaction discipline as the services (preview for milestone 1.8).
10. **Building a second BFF too soon.** One BFF + a few persona endpoints often suffices. Multiple BFFs is the right answer when teams diverge in cadence and priorities.

---

## Stretch goals (optional rabbit holes)

- **Implement GraphQL at `bff-parent`** (just the schema, no federation). Compare DX with REST: typed clients, query flexibility, single round-trip for arbitrary shapes vs the aggregation code you wrote.
- **Apollo Federation between two BFFs**: feel the schema governance overhead before you commit to it in Phase 3.
- **Build a `bff-teacher`** with its own persona-shaped endpoints. Three BFFs is the inflection point where "BFF per persona" stops feeling silly.
- **Implement request-level batching/dataloader pattern** to deduplicate identical downstream calls within a single BFF request.
- **Add ETag + `If-None-Match` for client-side caching.** Bandwidth wins; latency wins on cache hits.
- **Implement step-up authentication** at the BFF: certain endpoints require a fresh authentication ("password vault" pattern). Useful for senior actions on sensitive child records.
- **Build a developer portal** that exposes the BFF's OpenAPI spec, plays the contract tests, and lets a developer try requests with a test JWT. Senior teams build these for their internal customers.
- **Read Phil Calçado's *Pattern: Backends For Frontends* article** (the original SoundCloud articulation) and Sam Newman's follow-on. Note how the pattern's framing has shifted over a decade.

---

## Reflection questions

1. **Why is a BFF not a gateway?** Articulate the responsibility split.
2. **Your `/me/dashboard` aggregates from 4 services. If one is down, what does the user see?** Walk through the resilience pattern that produced that experience.
3. **Cache keys include `tenantId`, `userId`, and `day`. Why each one?** What bug happens if you drop any of them?
4. **A parent A passes `?childId=<parent B's child>`. What stops the leak at each layer (BFF, service, RLS)?** Describe the defense-in-depth chain.
5. **You measured p99 latency at 800ms; budget is 500ms. Where in your trace breakdown would you look first, and why?**
6. **You chose REST + JSON over GraphQL Federation. State the conditions under which the choice flips.**
7. **A new persona (e.g., school nurse) appears. What's the cost of giving them their own BFF vs cramming endpoints into an existing one?**

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §3.4 (BFFs), §8 (REST vs GraphQL guidance).
- **Sam Newman, *Pattern: Backends For Frontends*** — `samnewman.io/patterns/architectural/bff/`.
- **Phil Calçado's blog** — the original SoundCloud BFF articulation.
- **Pact docs** — `docs.pact.io`. Read the consumer-driven contracts intro carefully.
- **Apollo Federation docs** — for the GraphQL alternative.
- **Khan Academy engineering blog** — their GraphQL Federation journey is a useful counterweight to "REST forever."
- **Microsoft Azure docs:** *BFF pattern in Azure*.

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.7 to `Done`. Move to milestone 1.8 (Observability that earns its keep). The plumbing you've been adding to every milestone now becomes the operator surface.
