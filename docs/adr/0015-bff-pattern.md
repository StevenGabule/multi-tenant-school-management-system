# ADR-0015: Backend-for-Frontend per persona (vs shared API)

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Milestones 1.0–1.6 produced a stack of services: `gateway`,
`tenant-service`, `sis-service`, `academic-service`,
`enrollment-service`. Each owns a bounded context and exposes an HTTP
API shaped by its domain.

A real client — parent web, parent mobile, admin web, teacher
mobile — needs *combined* views: "today" for a parent (children + their
classes + recent grades + announcements), "school dashboard" for an
admin (enrollment counts + attendance + incidents). None of those views
is the natural shape of any single service; they're persona-specific
compositions.

Three plausible places to do that composition:

1. **In the client.** Each frontend orchestrates 4–7 service calls per
   screen. Implements its own authorization rules. Stays exactly as
   fast as the slowest service.
2. **In a shared API service** ("api-gateway-as-aggregator"). One
   backend serves all clients. The team that owns it becomes the
   bottleneck for every client team.
3. **In a Backend-for-Frontend** (BFF) per persona. One backend per
   client, owned by the client team, optimized for that persona's
   exact needs.

The choice has organizational consequences (team boundaries),
performance consequences (latency stacking), and security consequences
(authorization layering). Picking wrong calcifies a frontend ↔ backend
relationship that's expensive to undo.

## Decision

**Phase 1 introduces `bff-parent` as the first BFF — one BFF per
persona. Future personas (admin, teacher, student, district-staff)
each get their own BFF when warranted.**

We commit to BFF-per-persona as the *default* pattern for any
persona-specific aggregation that ships in the project. Shared API and
client-side orchestration remain in the toolkit but require explicit
justification (see "When a shared API wins" below).

### Specific rules

1. **One BFF per persona.** `bff-parent` for the parent, `bff-admin`
   for the school admin (Phase 1.7+), `bff-teacher` (when the teacher
   workflow exists), etc. The persona axis is "who is the user and
   what is the user trying to do" — not "which device they're on."
   Parent web AND parent mobile share `bff-parent`; the response
   shape they need is the same.

2. **The BFF does NOT own a database.** It composes from existing
   services. Persistence is the services' job. The only state the
   BFF holds is a Redis response cache, and that cache is best-effort
   (see ADR ref).

3. **Authorization is enforced at every layer:**
   - **BFF:** the parent's authenticated identity is the SOLE source
     of child IDs. Query params like `?childId=X` are NEVER honored.
     The aggregator derives IDs from `listChildren()` (which the
     downstream services scope by RLS+ABAC).
   - **Service:** SIS / academic still enforce their own RLS+ABAC.
     If the BFF leaks a non-parent's ID into a downstream call, the
     receiver rejects.
   - **Database:** RLS is the floor (ADR-0005, ADR-0013). A bypass at
     either of the two upper layers fails at the DB.

4. **The BFF speaks two languages:** REST + JSON externally (typed,
   OpenAPI-friendly), and HTTP/REST internally. gRPC inside the
   cluster is a Phase 2 concern (the architecture doc gives the
   conditions); for Phase 1 the consistency wins.

5. **Forward the user's JWT to downstream services.** No service-token
   hop in the BFF. Receivers see the real actor, apply their own
   policies, and don't need to coordinate with the BFF on tenant
   context. (Service tokens still apply for INTERNAL service-to-service
   calls like the saga executor — that's a different access pattern;
   ADR-0013 covers it.)

6. **Parallelism is the lever.** The aggregator uses `Promise.all` /
   `Promise.allSettled` for independent downstream calls. The
   per-child enrollment fetch is the canonical example: O(N+1)
   sequential becomes O(2) parallel.

7. **Partial responses, not all-or-nothing.** A failed per-child
   enrichment degrades that child only (renders with `enrollments: []`
   and a `degraded.reason` hint). A failed children-list IS fatal
   (no graceful default for "we don't know who the children are").

8. **Caching with actor-keyed keys.** The cache key includes
   `tenantId` AND `userId` AND `day`. Without all three, cross-actor
   leak is the standard failure. TTL is short (30s) — staleness is
   acceptable; correctness is not.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Client-side orchestration** | Zero new services; client-team autonomy | Latency stacks linearly; auth rules drift across clients; mobile rage-quits on slow networks; coordinated client+service deploys for any shape change | Reinvents the BFF, badly |
| **Shared API ("one api-gateway-aggregator for all")** | Less infra; one auth layer; easier monitoring | Bottlenecks on the team that owns it; persona-specific endpoints crowd the API; one client's needs block another's; "which client wanted this field?" is unanswerable in 18 months | Doesn't survive past two clients with diverging needs |
| **BFF per persona (chosen)** | Persona-shaped responses; client-team autonomy; latency owned per persona; per-BFF caching tuned for the persona; clear ownership | One more service per persona; partial-response semantics need design; contract drift between BFF and services has to be tested | n/a — the standard pattern Newman + Calçado articulated |
| **GraphQL Federation now** | Typed clients; query flexibility; single round-trip for arbitrary shapes | Schema governance overhead before we have the team to absorb it; we'd be adding federation on day one — explicitly rejected by `documentation.md` | ADR-0016 covers the specific REST-vs-GraphQL choice and its triggers |

## Consequences

**Positive:**

- Latency math is favorable. The /me/dashboard endpoint runs 1
  + N parallel calls. With N=10 children, ~60ms instead of ~330ms
  sequential. The parallelism is a load-bearing pattern, not a nice-to-
  have.
- The persona-shaped response means the client renders directly from
  the response — no client-side composition logic. UI bugs from "the
  client orchestrated the calls in the wrong order" don't exist here.
- The defense-in-depth chain (BFF → service → RLS) is explicit. A
  bypass attempt fails at multiple independent layers; no single fix
  protects the system, but no single failure exposes it either.
- Adding a new persona-specific endpoint touches `bff-parent` only.
  SIS doesn't need to know about the dashboard's shape; academic
  doesn't either. Frontend-driven evolution doesn't bottleneck on
  service teams.

**Negative / costs:**

- Each persona BFF is a new service to operate (Nest app, port,
  config, deployment). For a one-engineer project this is real cost.
  Mitigated by sharing the @org/auth-keycloak lib + the same
  scaffolding pattern.
- Contract drift risk: when SIS changes a response shape, the BFF can
  break silently. Mitigation: integration tests + Pact contract
  testing (Pact wiring deferred to milestone 1.8 — documented in DoD).
- Redis dependency for caching adds operational footprint. Mitigation:
  cache failures degrade to "always miss" — they don't break the
  request path.

**Risks:**

- **Engineer-too-eager-to-add-a-BFF**: a third BFF (e.g.,
  `bff-district-admin`) too soon is overhead without payoff. We add
  one when persona divergence is real (different endpoints, different
  performance budgets, different teams) — not "to be consistent."
- **BFF doing business logic**: a future commit might compute a GPA
  in the aggregator. That's a service concern. Mitigation: code
  review + this ADR as the rule.
- **`?childId=` regression**: a future engineer adds the param "for
  flexibility." The defense is structural today (the controller
  doesn't accept the param at all); a future Cmd-Z that adds it would
  break the auth model. ADR + tests guard against this.

### When a shared API wins (and we use it)

- **Pure CRUD admin tools** (e.g., a back-office interface) where every
  client is the same team and persona divergence is minimal. Phase 2
  may build a `back-office` service that's a shared API.
- **Internal-only consumers** with stable contracts. The
  `tenant-service` is itself a shared internal API; it doesn't need a
  BFF in front of it.

If a candidate doesn't fit those, default to BFF-per-persona.

## Consequences (continued)

**Follow-up work this enables / forces:**

- Milestone 1.7+: as personas accumulate, the BFF count grows. The
  scaffolding is shared (same Nest+Keycloak shape), so adding
  `bff-admin` is a half-day exercise.
- Milestone 1.8: contract tests (Pact) wire up between BFFs and
  services. Schema drift caught at PR time.
- Milestone 1.8: event-driven cache invalidation (new enrollment →
  invalidate the affected parent's BFF cache). Uses milestone 1.4's
  outbox substrate; today the BFF cache is TTL-only.
- Phase 2 ESLint rule: any BFF that imports a Prisma client or talks
  to a database directly is rejected — the BFF is composition, not
  persistence.

## References

- Sam Newman, *Pattern: Backends For Frontends*: <https://samnewman.io/patterns/architectural/bff/>
- Phil Calçado, "The Back-end for Front-end Pattern (BFF)" (2015,
  SoundCloud) — the original articulation.
- *Microservices Patterns*, Chris Richardson — Chapter 8 covers the
  API gateway / BFF decomposition.
- Internal:
  - `apps/bff-parent/src/dashboard/children.aggregator.ts` — the
    parallelism + partial-response pattern in code
  - `apps/bff-parent/src/downstream/downstream.client.ts` — JWT
    forwarding + per-call timeout
  - `apps/bff-parent/src/dashboard/dashboard.cache.ts` — actor-keyed
    cache discipline
- Phase 1.7 milestone: [`../phase-1/07-bff-aggregator.md`](../phase-1/07-bff-aggregator.md)
- Related: [ADR-0013](0013-iam-backbone.md) (the auth model the BFF
  inherits)
- Related: [ADR-0016](0016-rest-vs-graphql-bff.md) (the protocol
  choice for this BFF)
