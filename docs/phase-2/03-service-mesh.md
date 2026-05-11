# Phase 2.3 — Service mesh (Istio or Linkerd)

> **Concepts:** sidecar proxy pattern, mTLS between services, retries + timeouts as infrastructure, traffic shifting + canary, network policy, the mesh vs SDK trade-off
> **Estimated effort:** 3 weekends — the mesh is real ops investment
> **Status:** Not Started
> **Prerequisites:**
> - Milestone 2.0 complete (alerting must exist BEFORE the mesh adds another layer)
> - K8s familiarity (the mesh assumes you're past compose for service-to-service)

---

## What you'll learn

- **Sidecar proxy** as the mesh's core abstraction. Every pod gets an Envoy (Istio) or Linkerd-proxy that intercepts all traffic in and out. The application doesn't know.
- **mTLS** between services — automatic. The mesh issues short-lived certs per service identity; rotation is invisible to the app.
- **Retries + timeouts** as VirtualService configuration. Removes the Phase 1.5 hand-rolled retry budget from the saga executor; the mesh does it at the wire.
- **Traffic shifting**: 90% to v1, 10% to v2 — the canary pattern. Combine with the SLO burn-rate alerts from milestone 2.0: a v2 burning the budget faster gets auto-rolled-back.
- **The mesh vs SDK trade-off**: every retry / timeout / circuit breaker that lived in application code can move to the mesh. Less code; one more layer of "where is this happening?"

---

## Why this matters (senior perspective)

Phase 1's service-to-service was JWTs over HTTP. Works, debug-able, doesn't scale culturally — every new service has to re-implement timeouts, retries, mTLS plumbing. The mesh is the boundary where these concerns belong to infrastructure, not application code.

The senior posture has three parts:

1. **Service mesh is real operational cost.** Istio especially has a notorious learning curve and resource footprint (the sidecar tax). Linkerd is lighter; pick deliberately. ADR-0027 names the trade-offs.
2. **The mesh is not a security boundary by itself.** mTLS proves "this is service X's cert." Authorization (which tenant, which user) is still application-layer. The mesh + Keycloak + RLS = three layers; that's the senior shape.
3. **Don't move auth into the mesh.** A common mistake is "use Envoy's external_auth and move JWT validation to the mesh." Now your auth logic is in YAML, untestable by application devs. Keep authn at the app layer.

---

## Hands-on plan

### Step 1 — Pick: Istio vs Linkerd vs Consul Connect

Run a small spike for each. Decision criteria:
- Resource footprint per pod (Linkerd wins, Istio loses).
- Feature richness for traffic management (Istio wins).
- Operator complexity (Linkerd is simpler).
- Workforce familiarity (Istio has more documentation + Stack Overflow).

For a one-engineer learning project: Linkerd is the pragmatic pick. The ADR records the rationale + the conditions for flipping.

### Step 2 — Bring up the mesh on a kind cluster

The Phase 1 setup ran on docker-compose. The mesh assumes k8s. Spin up a kind cluster, deploy Linkerd, deploy the application services as k8s Deployments + Services. The compose remains for local-dev; the mesh + k8s is the production-shape environment.

### Step 3 — Inject sidecars

Linkerd's annotation `linkerd.io/inject: enabled` on each namespace. Verify every pod gets the linkerd-proxy sidecar. Traffic between services is now mTLS-encrypted at the wire.

### Step 4 — Move retry budgets to the mesh

The Phase 1.5 saga's `CrossServiceClient` has per-call timeouts in code. Replace those with Linkerd ServiceProfiles:

```yaml
apiVersion: linkerd.io/v1alpha2
kind: ServiceProfile
metadata:
  name: sis-service.default.svc.cluster.local
spec:
  routes:
    - name: POST /api/students
      condition:
        method: POST
        pathRegex: /api/students
      timeout: 250ms
      retryBudget:
        retryRatio: 0.2
        minRetriesPerSecond: 10
        ttl: 10s
      isRetryable: true
```

The application code can DELETE the AbortController timeout. ADR-0027 documents the migration.

### Step 5 — Canary deploys via traffic split

Deploy `sis-service:v2`. Linkerd's TrafficSplit:

```yaml
spec:
  backends:
    - service: sis-service-v1
      weight: 900
    - service: sis-service-v2
      weight: 100
```

The Grafana dashboard from milestone 1.8 now has a per-version cut. Watch v2's error rate vs v1's. SLO burn-rate alert from milestone 2.0 catches a bad v2 within minutes.

### Step 6 — Network policies (kubernetes-native, not mesh)

The mesh handles encryption + auth at the wire; k8s NetworkPolicy handles "who can reach whom" at the network layer. The TWO together = defense in depth.

Example: only `bff-parent` and `enrollment-service` can talk to `sis-service`; everything else gets connection refused. The mesh would still mTLS them; the NetworkPolicy denies the connection before the mTLS handshake.

### Step 7 — Observability integration

Linkerd exposes its own metrics (request rate, success rate, latency p99). These integrate with Prometheus seamlessly — add the Linkerd scrape target to milestone 1.8's config.

A new Grafana panel: "Service mesh — per-service success rate." Different signal from the application-layer's request rate; the mesh sees TLS-level + transport-level data the application doesn't.

### Step 8 — Tests + drill

- **mTLS verification**: capture traffic between two pods, confirm it's encrypted.
- **Cert rotation**: trigger a manual rotation, confirm services keep working.
- **Canary rollback drill**: deploy a deliberately-broken v2, watch the SLO alerts fire, manually shift traffic back to v1, total user impact within budget.
- **Network policy enforcement**: a service NOT in the allowlist tries to call `sis-service`; connection refused.

### Step 9 — ADRs

- `adr/0027-service-mesh-choice.md` — Linkerd vs Istio vs Consul; the chosen-and-why; the conditions to flip.
- `adr/0028-mesh-vs-sdk-resilience.md` — what moves to the mesh (timeouts, retries, mTLS) vs what stays in code (auth claims, business logic). The principle line.

---

## Definition of done

- [ ] Linkerd (or chosen mesh) running on a kind cluster; all services have sidecars.
- [ ] mTLS between every service-to-service connection; verified at the wire.
- [ ] Timeouts + retries for cross-service calls moved from app code to mesh ServiceProfiles.
- [ ] Traffic split (90/10) demoed; canary deploys testable.
- [ ] k8s NetworkPolicy restricts which services can talk to which; deny-by-default.
- [ ] Linkerd metrics integrated with Prometheus; per-service success rate visible on dashboard.
- [ ] Canary rollback drill: bad v2 deploy detected via burn-rate alerts; rolled back within SLO budget.
- [ ] ADR-0027 (mesh choice) and ADR-0028 (mesh vs SDK) written.

---

## Reflection questions

1. **You picked Linkerd over Istio. State the conditions under which you'd flip.**
2. **A service exhausts its retry budget. The mesh stops retrying. What's the application-layer response — and how do you make sure the BFF returns a degraded result, not a 5xx?**
3. **mTLS proves service X talked to service Y. It does NOT prove user U authorized the call. Walk through where that authorization happens.**
4. **A v2 deploy fires the fast-burn SLO alert at 30% traffic. What's the runbook?**
5. **A new engineer asks "why isn't auth in the mesh?" What's your one-sentence answer?**

---

## References

- Linkerd docs: <https://linkerd.io/2/getting-started/>
- Istio docs: <https://istio.io/latest/docs/>
- "Service Mesh: The Cost-Benefit Trade-off" — various engineering blog posts; the consensus is "mesh when you have ≥10 services or stringent compliance"
- Internal:
  - `apps/enrollment-service/src/sagas/cross-service.client.ts` — the in-code timeouts this migration moves to the mesh
  - `docs/adr/0018-slo-and-alerting.md` — the burn-rate alerts that catch a bad canary
