# ADR-0017: OpenTelemetry Collector as the central observability pipeline

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Milestone 1.0 wired traces directly from each service to a Jaeger
all-in-one container. Milestone 1.8 introduces real metrics + logs and
formalizes the observability story. The architectural question:
**where do cross-cutting concerns live — sampling, PII redaction,
attribute enrichment, format conversion?**

Three plausible patterns:

1. **Per-service direct export.** Each service ships traces, metrics,
   and logs straight to its own backend (Tempo, Prometheus, Loki).
   Simplest to wire; no central component.
2. **Sidecar collector per service.** Each service has its own
   collector container. Local concerns local; cluster scaling per pod.
3. **Central collector pipeline.** One (HA-able) collector deployment;
   all services point at it; it owns the cross-cutting concerns and
   fans out to backends.

The decision compounds: every service that ever joins the platform
makes its observability story. Per-service ad-hoc choices fragment.

## Decision

**The OpenTelemetry Collector (otelcol-contrib) is the central
pipeline. Every service exports OTLP to the collector; the collector
owns sampling, PII redaction, attribute enrichment, and format
conversion; it fans out to Tempo (traces), Prometheus (metrics), and
Loki (logs).**

### Specific rules

1. **Single OTLP endpoint per environment.** Services point at one
   collector URL (`OTEL_EXPORTER_OTLP_ENDPOINT`). The collector itself
   may be a single instance (Phase 1) or a horizontally-scaled
   deployment (Phase 2 when load demands).

2. **Cross-cutting concerns live in the collector pipeline:**

   - **Sampling.** Tail-based: 100% of error traces, 100% of slow
     (>500ms) traces, 5% probabilistic on healthy ones. The decision
     happens AFTER the trace is complete (5s `decision_wait`); only
     the collector has that visibility.
   - **PII redaction.** `attributes/redact` processor deletes
     `http.request.body`, `http.response.body`, `password`, `token`,
     `secret`; hashes `user.email`, `user.phone`. Defense in depth —
     services should redact at source; the collector is the backstop
     for what slipped through.
   - **Attribute enrichment.** `attributes/baggage` copies baggage
     values onto spans (the `tenant.id` we set in KeycloakAuthGuard
     ends up as a span attribute, queryable everywhere). NOTE: the
     baggage→attribute promotion is partial today — the load-bearing
     path is a direct `span.setAttribute` in the auth guard. Phase 2
     may add a SDK-side BaggageSpanProcessor for full coverage.
   - **Format conversion.** Prometheus exporter converts OTLP metrics
     to the Prometheus exposition format. Loki's OTLP receiver does
     the inverse for logs. Services don't have to know which backend
     speaks which format.

3. **Receivers are OTLP-only.** No `prometheus_scrape` receiver, no
   `filelog` receiver. Forces every service to emit OTLP — the
   uniform contract is the value proposition. Postgres / Redis
   metrics (USE method) come via dedicated exporters
   (postgres-exporter, redis-exporter) that themselves emit OTLP or
   are scraped by Prometheus directly.

4. **Backends are pluggable.** Tempo today; Datadog or Honeycomb
   tomorrow if the operations story changes. The application layer
   doesn't change — only the collector's exporter config does.

5. **Backpressure → drop, not crash.** If the collector is down, the
   services' exporters drop signals (logged warnings). The application
   never blocks on observability. ADR risk #1 below.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Per-service direct export** | Zero central infra; simplest to wire | Each service has to know each backend's format; cross-cutting changes (e.g., new redaction rule) are N service deploys; tail-based sampling impossible (services don't see the whole trace) | Doesn't scale past 2-3 services |
| **Sidecar collector** | Local concerns local; isolation per service | N collectors to operate; tail-based sampling still impossible (sidecar sees one service's spans, not the trace); doubles compute footprint | Overkill before genuine multi-tenancy of the observability layer |
| **Central collector (chosen)** | One pipeline owns the cross-cutting story; tail-based sampling works; backend swaps are config-only | Single point of failure (mitigated: services drop on collector down); resource footprint of one container | n/a — the OpenTelemetry-native pattern |
| **Vendor-managed (Datadog Agent, Honeycomb Refinery, etc.)** | Less infra to run; vendor-tuned defaults | Lock-in; data residency (education vertical); cost scales aggressively past hobby tier | Right for a different team profile; we keep self-hosted optionality |

## Consequences

**Positive:**

- Cross-cutting changes ship in ONE collector reload, not N service
  deploys. Adding a new PII regex is a config edit and a `docker
  compose up -d --no-deps otel-collector`.
- Tail-based sampling works as advertised. Looking at `tenant.id`
  values in Tempo today, three distinct tenants from earlier test
  runs are searchable — that data would have been ~95% lost under
  uniform 1% head sampling.
- Backend churn is contained. Phase 2 may move to a managed Tempo or
  swap Loki for ClickHouse-based logs (Phase 3 evaluating); the
  services don't care.
- Format conversion at the edge. Prometheus's exposition format and
  OTLP's protobuf are different beasts; one place that knows both.

**Negative / costs:**

- One more thing to operate. Collector restarts mid-stream lose
  in-flight signals (acceptable; they're samples). Misconfigured
  pipelines silently drop data — see risks below.
- The collector is a single point of failure for the observability
  story. If it's down, no traces, no metrics, no logs are collected.
  Mitigation today: services drop signals; users see no impact.
  Phase 2: HA the collector behind a service mesh.
- Configuration sprawl. The collector config is ~100 lines of YAML
  for what could be ~50 lines of code at the SDK level. Trade-off
  paid for the central-pipeline benefits.

**Risks:**

- **A misconfigured exporter silently drops data.** Symptom: "the
  dashboard is empty"; cause: a typo in the Tempo endpoint URL.
  Mitigation: collector has its own debug exporter (verbosity=basic)
  used during initial bring-up; pipeline_dataloss_total metric is
  on the operational dashboard's roadmap (Phase 2 self-monitoring).
- **Tail-sampling decision_wait too short.** Saga retries take ~1.5s
  each × 3 = 4.5s; we set `decision_wait: 5s`. If a future workflow
  takes longer, the trace is sampled prematurely. Re-tune when the
  longest-known trace exceeds 80% of the wait.
- **High-cardinality labels explode Prometheus.** `tenant_id` × 50
  routes × 7 statuses × 6 services ≈ tens of thousands of series at
  1000 tenants. Today the cardinality is small; Phase 2 should adopt
  Prometheus's exemplar-only attribution for tenant_id (keep the
  metric without the label, attach a sample trace_id per bucket).
- **Collector itself becomes a tenant of compute.** ~100MB RAM at
  rest, scales with throughput. Sized for Phase 1 dev; Phase 2
  capacity-planning will be its own milestone.
- **A bug in the redaction rule leaks PII.** Defense in depth:
  services SHOULD redact at source; the collector is backstop. If
  redaction is the only layer, a regression at the collector =
  PII in Loki. Document in the redaction rule + revisit on every
  schema change.

**Follow-up work this enables / forces:**

- Milestone 1.8 (in-progress): Grafana dashboard provisioned via
  collector-fed metrics.
- Phase 2: HA-deploy collector + add `loadbalancing` exporter for
  multi-instance tail-sampling cohesion.
- Phase 2: Self-observability — collector exports its own
  `otelcol_*` metrics to Prometheus; alert when
  `otelcol_exporter_send_failed_spans_total > 0`.
- Phase 2: Postgres + Redis USE metrics via dedicated exporters
  (postgres-exporter, redis-exporter) feeding Prometheus directly.
- Phase 2 ESLint rule: any service that imports a Prometheus client
  directly (instead of OTel metrics SDK) is rejected.

## References

- OpenTelemetry Collector docs: <https://opentelemetry.io/docs/collector/>
- Brendan Gregg's USE method: <http://www.brendangregg.com/usemethod.html>
- Tom Wilkie's RED method: <https://thenewstack.io/monitoring-microservices-red-method/>
- Charity Majors, "Observability vs Monitoring":
  <https://charity.wtf/2018/05/27/observability-3-cs-versus-the-3-pillars/>
- Internal:
  - `infra/observability/collector/config.yaml` — the pipeline
  - `libs/observability/src/lib/init-otel.ts` — service-side SDK init
- Phase 1.8 milestone: [`../phase-1/08-observability.md`](../phase-1/08-observability.md)
- Related: [ADR-0018](0018-slo-and-alerting.md) (the SLO + alerting
  formalism this pipeline serves)
