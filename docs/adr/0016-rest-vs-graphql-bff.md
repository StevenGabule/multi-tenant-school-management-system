# ADR-0016: REST + JSON for BFFs (with explicit GraphQL Federation triggers)

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

ADR-0015 commits to BFF-per-persona. The next sub-decision: what
protocol does each BFF speak — externally to its client, and internally
to the services it composes?

Two live options in 2026:

1. **REST + JSON.** Persona-shaped endpoints (`GET /me/dashboard`),
   typed via OpenAPI, validated via Zod. The internal calls are also
   REST + JSON. Curl-able, debuggable, well-understood by every
   engineer hired in the past 25 years.

2. **GraphQL** (with or without Federation). The BFF exposes a typed
   schema; clients query for exactly the shape they need; multiple
   BFFs / services can be federated into one supergraph.

The original architecture doc is explicit: *"Don't introduce federation
on day one; it requires schema governance discipline most early teams
lack."* But the framing leaves room: we should at least say what would
make us flip.

## Decision

**Phase 1 BFFs speak REST + JSON, externally and internally. We
commit to GraphQL Federation when explicit triggers fire — not before.**

### Specific rules

1. **REST for the BFF's external surface.** Persona-shaped endpoints
   like `/me/dashboard`, `/me/notifications`, `/me/children/:id`.
   Each endpoint returns one well-shaped JSON document.

2. **Zod schemas for request validation, OpenAPI for documentation.**
   Same toolchain as the services (sis-service, academic-service).

3. **REST for the BFF's internal calls** to SIS, academic, etc.
   Same protocol both sides of the BFF — one mental model. gRPC for
   internal service-to-service is a Phase 2 concern; the consistency
   wins for Phase 1.

4. **No partial-response semantics in the protocol** (no GraphQL
   `null`-with-error; no JSON-API `meta.errors`). Failures degrade
   visibly via a top-level `degraded: boolean` and a per-section
   `degraded: { reason: string }` hint. This keeps the contract
   simple for clients and OpenAPI-able.

### GraphQL Federation graduation triggers

We commit to evaluating the migration when ANY of these become true:

  1. **Three or more BFFs are running**, with significant overlap in
     the data they consume from services. The redundancy of
     `getChildById` calls across `bff-parent`, `bff-teacher`, and
     `bff-admin` is exactly what federation solves.
  2. **Frontend teams ask for "exactly this shape" routinely**, and
     the BFF endpoint count is creeping past ~30. Per-screen REST
     endpoints become a maintenance burden; GraphQL's "client picks
     the shape" makes that maintenance vanish.
  3. **A second team owns a downstream service** that needs to
     contribute its own subgraph to the federated schema, and we
     have the team count to support a schema-governance role.
  4. **The BFF aggregation logic becomes complex enough that we're
     reinventing GraphQL** in JavaScript (multiple data loaders,
     dependency-resolved batching, query-shape-driven caching). At
     that point we're paying GraphQL's costs without its benefits.
  5. **Public API consumers** appear (other developers querying our
     API). GraphQL's introspection + typed schema is a major DX
     advantage over hand-rolled REST + OpenAPI.

If NONE of the triggers apply by milestone 2.0 review, we stay on
REST. The migration is non-trivial (schema design + Apollo Federation
infra + tooling shift); it must pay back.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **REST + JSON (chosen)** | Universal tooling; curl-able; OpenAPI-able; matches the services' protocol; zero new infrastructure; mental model is "endpoint per screen" | Persona endpoint count grows linearly with screens; clients can't ask for partial shapes; over-fetch is the default | n/a — fits Phase 1 perfectly |
| **GraphQL (single BFF, no federation)** | Client picks the shape; typed clients; single round-trip; built-in introspection | Tooling complexity (Apollo Server / Yoga / etc.); team needs to know GraphQL; query-cost analysis becomes a thing; N+1 fetch is the default failure mode (DataLoader required) | Solo team; no client team to buy in yet; complexity outweighs benefit |
| **GraphQL Federation (multi-BFF)** | What we want at scale: each BFF/service contributes a subgraph; clients query a unified schema; federation router does the composition | Schema-governance role required; one wrong subgraph version breaks the supergraph; deploy choreography between subgraph owners; Apollo Federation v2 routing infra (Apollo Router / Cosmo) | "Don't introduce federation on day one" — original architecture doc, applies to Phase 1+2 |
| **gRPC + protobuf internally, REST externally** | Faster + smaller internally; strict types | Two protocols to maintain; no curl debugging on internal calls; contract testing harder | gRPC's wins emerge at >100k qps; we're nowhere near that |
| **JSON-RPC** | Simple; universal | No native HTTP semantics (status codes, caching); marginal benefit over REST | Marginal value over REST; not worth the lock-in |
| **tRPC** | End-to-end TypeScript types; extremely DX-positive | Lock-in to TypeScript on both ends; no real cross-language story; tooling is newer | Excellent for monorepo SaaS; the school-management space will eventually have non-TS clients |

## Consequences

**Positive:**

- Zero new tooling. The BFF reuses Nest + Zod + Express + JSON — same
  stack as the services. An engineer who knows the service codebase
  can read the BFF code in 5 minutes.
- Curl-debuggable. The /me/dashboard endpoint is a single GET; you
  can reproduce a customer's experience from a terminal. With
  GraphQL the same investigation requires a query payload + variable
  binding.
- HTTP semantics work. ETag + If-None-Match → 304. Caching headers.
  Status codes mean what they say. With GraphQL, every response is
  200 OK and the body has the errors — losing the HTTP layer's
  meaning.
- Onboarding is fast. The next engineer who joins the project can ship
  to the BFF in their first week.

**Negative / costs:**

- Persona endpoint count grows. `/me/dashboard` today; tomorrow
  `/me/notifications`, `/me/messages`, `/me/grades/:childId/:term`.
  Each is a hand-shaped endpoint. At ~30 endpoints per BFF this gets
  burdensome — that's trigger #2.
- Over-fetching is the default. The dashboard endpoint returns ALL
  children even if the client only renders one widget. Mitigation:
  short cache TTL + ETag + 304s minimize the bandwidth cost on
  refreshes.
- Cross-BFF redundancy: when `bff-admin` lands, it'll re-query the
  same data shapes. The duplication is real; trigger #1 catches it.

**Risks:**

- **REST endpoint sprawl** as personas multiply. Discipline:
  per-persona BFF (not "one BFF for all personas"), per-screen
  endpoint where the screen is stable, per-domain endpoint where
  the screen is in flux.
- **OpenAPI drift**: the spec falls out of sync with implementation.
  Mitigation: nestjs-zod (used in the services) auto-generates
  OpenAPI from Zod schemas; the BFF should adopt it next.
- **Frontend asks for federation early** because they read about
  Apollo. Trigger #5 covers the "real public API" case; until then
  the frontend can build typed clients from OpenAPI. Document the
  triggers; resist the pressure.

**Follow-up work this enables / forces:**

- Milestone 1.8: BFF metrics for endpoint count, p99 per endpoint.
  When count > 20 OR p99 budget breach, revisit the protocol choice.
- Milestone 1.8: contract tests (Pact) between BFF and services.
  Same story whether the protocol is REST or GraphQL — but Pact
  starts simpler with REST.
- Phase 2 ESLint rule: any BFF endpoint that returns a database row
  shape (raw Prisma object) is rejected. The BFF returns
  persona-shaped responses, not service-shaped ones.

## References

- Apollo Federation docs: <https://www.apollographql.com/docs/federation/>
- *GraphQL Federation 2*, Khan Academy engineering blog — the
  practical case study for "federation pays off when…"
- Sam Newman, *Building Microservices, 2nd ed.* — chapter on protocol
  choices.
- "Why we chose REST" — various team blog posts; aggregated wisdom is
  "REST until you can't."
- Internal:
  - `apps/bff-parent/src/dashboard/dashboard.controller.ts` — the
    REST endpoint shape
  - `apps/sis-service/src/modules/students/controllers/students.dtos.ts`
    — Zod-from-DTO pattern reused for BFFs
- Phase 1.7 milestone: [`../phase-1/07-bff-aggregator.md`](../phase-1/07-bff-aggregator.md)
- Related: [ADR-0015](0015-bff-pattern.md) (the BFF pattern this
  protocol choice lives inside)
