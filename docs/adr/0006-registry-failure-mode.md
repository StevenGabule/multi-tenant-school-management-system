# ADR-0006: Tenant registry failure mode is fail-closed

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Every authenticated request through the gateway resolves its `tenantId` claim
through the [tenant registry client](../../libs/tenant-registry/src/lib/tenant-registry.service.ts):
LRU → Redis → HTTP to tenant-service. The registry is the source of truth
for whether a tenant exists, what tier it's on, and — critically for this
ADR — whether it's currently *active*, *suspended*, *terminated*, etc.

When the registry can't be reached (tenant-service down, network partition,
Redis down AND tenant-service down, etc.), the guard has a binary choice:

- **Fail open**: serve the request anyway, possibly using stale cached data
  or assuming the tenant is active.
- **Fail closed**: refuse the request with `503 Service Unavailable`.

The choice has wide blast radius. Every protected endpoint is affected.
The fail-open extreme is "the system serves traffic during a registry
outage but might admit a suspended tenant." The fail-closed extreme is
"the system goes down whenever the registry does, even for tenants that
aren't suspended."

This ADR locks in the choice for Phase 1 and documents the conditions
under which it should be revisited.

## Decision

**The gateway fails closed (503) when the tenant registry is unreachable.**

Concretely, in [`JwtAuthGuard.canActivate`](../../apps/gateway/src/auth/jwt-auth.guard.ts):

```typescript
try {
  tenant = await this.registry.findById(payload.tenantId);
} catch (err) {
  if (err instanceof TenantRegistryUnavailableError) {
    throw new ServiceUnavailableException({
      message: 'tenant registry temporarily unavailable; please retry shortly',
    });
  }
  throw err;
}
```

Two corollaries:

1. **The 3-layer cache is the resilience.** LRU (60s) + Redis (5min) + HTTP.
   The HTTP layer must be unreachable AND Redis must be unreachable AND
   the LRU must have expired before any pod fails closed for a given tenant.
   In practice this only happens during full-stack outages, not single-node
   failures.

2. **`/livez` and `/readyz` skip the guard.** Probes do not need tenant
   resolution — that would tie pod liveness to registry availability,
   which is exactly the cascading failure we're trying to avoid.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Fail closed (chosen)** | Cannot serve a suspended tenant; security guarantee preserved end-to-end | Registry outage = gateway 503s for warm-but-expired tenants; widens blast radius of registry failures | n/a |
| **Fail open (serve anyway)** | Higher availability during registry outages | Suspended tenant reactivated for the duration of the outage; payment delinquencies, security suspensions, regulatory holds all bypassed | The whole point of the registry is that we trust its judgement on whether to serve a tenant. Bypassing it on outage defeats the design. |
| **Hybrid: serve from last-known-good cache (no expiry on failure)** | Best of both worlds: serves recent-active tenants, refuses unknowns | Drift between cached state and real state grows during outages — a tenant suspended at 09:00 still gets served at 10:00 if no pod has reloaded. Operational confusion: "did the suspension propagate?" can't be answered. | Risk profile sits between the two options without resolving the fundamental tension; harder to reason about |
| **Read-only mode (allow GET, refuse POST/PATCH/DELETE)** | Reduces blast radius — reads continue, writes don't | Still admits a suspended tenant to read sensitive data; not actually safer for the suspension case | Doesn't address the security concern that motivated fail-closed |

## Consequences

**Positive:**

- A suspended tenant cannot reach gateway endpoints even during a tenant-service
  outage. The security floor is the same as the steady-state floor.
- Operations are easier to reason about: "tenant-service down → gateway 503s"
  is a single, predictable failure mode.
- Forces investment in tenant-service availability — the registry becomes
  the most critical service in the system, which matches its role.

**Negative / costs:**

- Registry availability is an availability ceiling for the whole platform.
  If the registry is at 99.9%, the gateway can't be more available than 99.9%
  for any tenant whose cache has expired during the outage.
- A registry deploy that includes downtime takes the whole platform down for
  any cold-cache tenant during the deploy window. Mitigation: zero-downtime
  rolling deploys, Phase 2.
- Cold-start scenarios are vulnerable: a pod that just started has no LRU,
  and if Redis is down too, the first request for a tenant triggers HTTP.
  If HTTP is also down, the tenant 503s even if the registry comes back
  10 seconds later.

**Risks:**

- **Cache stampede on registry recovery.** When the registry comes back, every
  pod's first request for an uncached tenant triggers an HTTP fetch. With many
  tenants and many pods, this can overwhelm the recovering registry. Mitigation:
  Phase 2 adds request coalescing (single-flight) per tenant id at the LRU
  layer.
- **The fail-closed default propagates to new services.** Every new service
  that consumes `@org/tenant-registry` inherits this contract. If a downstream
  service decides to fail open, the platform gets inconsistent behavior.
  Mitigation: code review + ESLint rule (Phase 2) flagging any
  `findById(...).catch(() => null)`-style suppression.
- **Operators may panic during outages.** A widespread 503 looks like a
  total outage. Mitigation: a clear status-page message ("tenant directory
  temporarily unavailable") and a runbook that stops the
  "we have to serve traffic, flip the switch!" instinct.

**Follow-up work this enables / forces:**

- Tenant registry needs a higher SLO than any service that depends on it.
  Phase 2 budget: 99.99% availability for tenant-service (more 9s than the
  99.9% gateway target).
- Phase 2 introduces the single-flight pattern in the registry client to
  prevent cache stampede.
- Milestone 1.8 (observability) must surface registry-unavailable counters
  prominently in the operator dashboard. A 503 spike on the gateway is
  almost always a registry problem; the dashboard should make that obvious.

## References

- Library: [`libs/tenant-registry/src/lib/tenant-registry.service.ts`](../../libs/tenant-registry/src/lib/tenant-registry.service.ts)
- Guard: [`apps/gateway/src/auth/jwt-auth.guard.ts`](../../apps/gateway/src/auth/jwt-auth.guard.ts)
- Integration test (proves both 5xx → throws and 404 → null): [`libs/tenant-registry/src/lib/tenant-registry.integration.spec.ts`](../../libs/tenant-registry/src/lib/tenant-registry.integration.spec.ts)
- Phase 1.2 milestone: [`../phase-1/02-tenant-registry.md`](../phase-1/02-tenant-registry.md), step 6
- Related: [ADR-0001](0001-tenancy-tier-model.md), [ADR-0007](0007-control-plane-db-strategy.md)
