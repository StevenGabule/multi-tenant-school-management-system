# Phase 1.8 — Observability that earns its keep

> **Concepts:** OpenTelemetry collector architecture, the signal trinity (traces / metrics / logs), `tenant_id` as OTel baggage, Tempo + Prometheus + Loki + Grafana stack, RED + USE methodologies, SLOs and error budgets, alerting on symptoms vs causes, structured logging, PII redaction in the pipeline, sampling strategy
> **Estimated effort:** 3 weekends — observability is genuinely deep and most engineers learn it superficially
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 1.0–1.7 complete (you have a working multi-service system that emits OTel traces from line one — milestone 1.0 set this up)
> - Read [`../../documentation.md`](../../documentation.md) §7 (DevOps & Observability) carefully
> - Read at least one chapter of *Site Reliability Engineering* (Google) or the SRE Workbook on SLOs and error budgets

---

## What you'll learn

- The **OpenTelemetry collector architecture**: receivers (what to ingest), processors (how to transform), exporters (where to send). Why the collector is the right boundary for cross-cutting observability concerns (PII redaction, sampling, fan-out).
- The **signal trinity** — traces, metrics, logs — and the deliberate choice of which one answers each question. Most engineers default to logs; senior engineers reach for the right tool.
- **`tenant_id` as OTel baggage**: the propagation primitive that lets you filter every signal by tenant, which is non-negotiable at 1,000 schools.
- The **RED method** (Rate, Errors, Duration) for service-level metrics and the **USE method** (Utilization, Saturation, Errors) for resource-level metrics. Together they cover ~95% of operational observability needs.
- **SLO definition** in concrete terms: an availability SLO, a latency SLO, an error budget, a burn-rate alert. The SRE workbook formalism applied to your services.
- **Alerting on symptoms vs causes**: page when users are affected, not when CPU is high. Why this is the single most common alerting mistake.
- **Structured JSON logging** with trace context injection (`trace_id`, `span_id` in every log line), and PII redaction in the pipeline so logs never contain sensitive data.
- **Sampling strategy**: head-based sampling vs tail-based, why "100% of error traces" matters more than "1% of all traces," and what tail-based sampling buys you.
- The **dashboard discipline**: a dashboard built without a clear question becomes wallpaper. What "earns its keep" means.

---

## Why this matters (senior perspective)

Observability is the difference between operating a system and being operated by it. A system without observability:

- A customer reports "the dashboard is slow." You have no idea which service. You restart everything; the problem goes away or it doesn't. You learned nothing.
- A saga gets stuck on step 4. You read logs across 5 services trying to piece together the trace. You lose 90 minutes; the saga is still stuck.
- The error rate creeps from 0.1% to 0.5% over a week. No one notices because it's never been measured. By the time a customer escalates, it's 2%.

A system *with* observability:

- Customer reports "dashboard slow." You filter traces by their tenant; the BFF span shows SIS taking 800ms; SIS span shows a slow query; you have a culprit in 2 minutes.
- Saga stuck. The trace shows step 4's last attempt 11 minutes ago, a 503 from notification-service. The notification dashboard shows error spike. Root cause in 5 minutes.
- Error rate creeping. The error-budget burn rate alert fires when the budget projects to deplete in 1 day. You have time to investigate before customers notice.

The senior posture has four parts:

1. **Three signals, three questions.** Traces answer "why was this request slow?" Metrics answer "is the system healthy?" Logs answer "what happened in this specific event?" Don't conflate them. Don't log what should be a metric.
2. **`tenant_id` everywhere or nothing.** A trace, log, or metric without `tenant_id` cannot be filtered to one tenant. At 1k tenants, that means it can only ever be aggregated, never debugged. The baggage propagation must be religion.
3. **Alert on symptoms.** "p99 latency > 1s for 10 minutes" pages because users are slow. "CPU > 80%" pages because... nothing — CPU at 80% might be perfectly fine. Symptom-based alerts wake you when waking is needed; cause-based alerts wake you for false positives.
4. **Sampling is a design decision, not a default.** 100% sampling at scale is unaffordable; uniform 1% sampling drops the rare error traces (the ones you actually need). Tail-based sampling keeps every trace where an error occurred, plus a small sample of successful ones. This is the senior choice.

The fifth senior moment: **the dashboard you don't check is wallpaper.** A dashboard's job is to answer one operational question — "is the platform healthy right now?" or "is this tenant being served well?" If a dashboard exists but no one can articulate the question it answers, delete it.

---

## Hands-on plan

### Step 1 — Stand up the observability stack

Add to `docker-compose.yml`:

- **OpenTelemetry Collector** (`otel/opentelemetry-collector-contrib`) — the central pipeline. Receivers: OTLP (gRPC + HTTP). Processors: `batch`, `tail_sampling`, `resource`, `attributes` (for redaction). Exporters: `otlphttp` to Tempo, `prometheus` for metrics, `loki` for logs.
- **Grafana Tempo** (`grafana/tempo`) — trace backend.
- **Prometheus** — metrics backend. Configure to scrape the collector's `/metrics` endpoint.
- **Grafana Loki** + **Promtail** (or use Loki's OTLP receiver directly) — logs backend.
- **Grafana** — UI. Pre-provision the four datasources via config files.

Replace the all-in-one Jaeger from milestone 1.0 with this stack. The collector becomes the single OTLP endpoint your services point at; everything fans out from there.

### Step 2 — Configure NestJS to export all three signals

You already export traces (milestone 1.0). Add:

- **Metrics**: `@opentelemetry/sdk-metrics` with a periodic exporter to OTLP. Auto-instrument HTTP handlers; manually instrument business metrics (saga success rate, outbox lag, registry cache hit rate).
- **Logs**: `pino` for structured JSON, with the OTel logs SDK bridging logs to OTLP. Each log line includes `trace_id`, `span_id`, `tenant_id`, `service`, `version`.

Verify all three flow into the collector and reach their respective backends:

```
Service → OTel Collector → {Tempo (traces), Prometheus (metrics), Loki (logs)}
```

### Step 3 — `tenant_id` as OTel baggage

The baggage API propagates context across span boundaries:

```typescript
// at the JWT validation guard:
import { propagation, ROOT_CONTEXT } from '@opentelemetry/api';
const baggage = propagation.createBaggage({
  tenant_id: { value: tenantId },
  user_id: { value: userId },
});
const ctx = propagation.setBaggage(ROOT_CONTEXT, baggage);
// continue with ctx — baggage propagates with context
```

Configure the collector's `attributes` processor to copy baggage values onto every span as attributes:

```yaml
processors:
  attributes:
    actions:
      - key: tenant.id
        from_attribute: baggage.tenant_id
        action: insert
```

Now every span has `tenant.id`. Filter in Grafana: `{tenant.id="<uuid>"}` shows that tenant's traces only.

For metrics, propagate `tenant.id` as an attribute on the metric — but be cautious: high-cardinality labels in Prometheus are expensive. Use **exemplars** (Prometheus feature) to attach a sample trace ID to a histogram bucket without exploding cardinality. Or push tenant-segmented metrics to Tempo via OTel exemplars.

For logs, the `tenant_id` is already in the structured JSON; Loki indexes it as a label.

### Step 4 — RED method on every service

For every HTTP endpoint, expose:

- **Rate** — `http_requests_total{service, route, method, status}` counter.
- **Errors** — derived from rate where `status >= 500`.
- **Duration** — `http_request_duration_seconds{service, route}` histogram.

NestJS auto-instrumentation handles most of this; verify the labels are correct and add `tenant.id` via the OTel collector's attributes processor.

For every queue (BullMQ, outbox), expose:

- **Lag** — current backlog count.
- **Throughput** — jobs processed per second.
- **Failure rate** — failed jobs / total jobs.

For every saga executor:

- **Active saga count** — by status (running, compensating).
- **Step duration histogram** — by step name.
- **Compensation rate** — fraction of sagas that go to compensation.

These are the metrics that make the system operable. Without them, you're flying blind.

### Step 5 — USE method on every resource

For each Postgres database:
- **Utilization**: `pg_stat_database` — connections, transactions, cache hits.
- **Saturation**: `pg_stat_activity` — active queries, wait events, lock waits.
- **Errors**: log-derived (deadlocks, query failures).

For each Redis:
- **Utilization**: `info memory` (used_memory).
- **Saturation**: `info clients` (blocked clients), `info stats` (rejected connections).
- **Errors**: from Redis logs.

For each Kafka (when you graduate from LISTEN/NOTIFY): consumer lag is the canonical RED+USE metric.

Use `postgres-exporter`, `redis-exporter`, etc. — well-known Prometheus exporters.

### Step 6 — One operational dashboard

Build *one* dashboard before you build a second. The first dashboard answers: **"Is the platform healthy right now, and is any one tenant being underserved?"**

Panels:
- Top row: gateway request rate, error rate (5xx + 4xx), p50/p95/p99 latency. RED for the gateway.
- Per-service health: a table of services with their RED metrics and SLO compliance.
- Tenant top-N: tenants with highest request rate, highest error rate, highest p99 latency. The single most useful panel for a multi-tenant system.
- Database health: connections used/max, slow query rate, replication lag (if applicable).
- Queue health: outbox lag, BullMQ backlog, dead-letter count.
- Saga health: active sagas, compensation rate, p95 saga duration.

Annotate the dashboard with deploys (Grafana annotations from CI). Now you can see: "p99 latency went up after this deploy" without guesswork.

### Step 7 — Define SLOs and error budgets

For the gateway:
- Availability SLO: 99.9% over 30 days. Error budget: 0.1% × 30 days = 43 minutes/month.
- Latency SLO: p99 < 500ms. Error budget defined by "minutes where p99 > 500ms."

For each service: similar pair.

Error budget burn rate alerts (Google SRE workbook formalism):

- **Fast burn**: 14.4× normal burn rate over 1 hour → 5% of monthly budget consumed in 1 hour. Page immediately.
- **Slow burn**: 6× normal burn rate over 6 hours → 10% of monthly budget consumed in 6 hours. Page during business hours.

These two alerts catch both spikes ("everything is on fire") and creep ("error rate has crept up over a day"). The traditional "p99 > X for 5 minutes" alert misses the latter and oversensitively fires on the former.

### Step 8 — Alerting discipline

Rules to follow:

- **Page on symptoms.** "p99 latency > SLO for 10 minutes." "Error budget fast burn." "Saga compensation rate > 5% for 5 minutes."
- **Don't page on causes.** "CPU > 80%" — at 80% CPU, the system might be perfectly healthy. Page on the symptom (latency, errors), not the resource.
- **Every alert has a runbook.** A page that says "fix it" without saying *how* is operator hostility. The runbook lives in the alert annotation.
- **Severities matter.** P0 wakes someone up. P1 is tomorrow morning. P2 is a ticket. Most teams have one severity (P0); the result is alert fatigue.

In Grafana (or Alertmanager), configure the alerts. Test by intentionally triggering one (e.g., add `await sleep(2000)` to a route, watch the alert fire).

### Step 9 — Structured logging with trace correlation

Every log line is JSON, includes:

```json
{
  "ts": "2026-05-10T12:34:56.789Z",
  "level": "info",
  "service": "sis-service",
  "version": "1.4.2",
  "trace_id": "abc123...",
  "span_id": "def456...",
  "tenant_id": "uuid",
  "user_id": "uuid",
  "request_id": "uuid",
  "msg": "student created",
  "studentId": "uuid"
}
```

Use `pino` with `pino-http` for HTTP logging. Configure the OTel logs SDK to inject `trace_id`/`span_id` automatically.

Loki indexes the labels (`service`, `level`, `tenant_id`); the rest is searchable JSON. In Grafana, you can `{service="sis-service",tenant_id="<uuid>"}` and see only that tenant's logs from that service.

Crucially: from a trace span in Tempo, click "logs for this span" and Grafana opens Loki filtered by the trace ID. The three signals are now correlated.

### Step 10 — PII redaction in the pipeline

Logs catch sensitive data by accident: stack traces with email addresses, error messages with phone numbers, debug-level dumps of request bodies.

Configure the collector's `attributes` processor:

```yaml
processors:
  attributes:
    actions:
      - key: http.request.body
        action: delete                # don't ship request bodies
      - key: user.email
        action: hash                  # hash if you must
      - pattern: ".*ssn.*"
        action: delete
```

For free-form log message text, a regex-based redaction (emails, SSN patterns, credit-card-like numbers) at the collector layer. Prefer redacting at *source* (the application code), with the collector as backstop. Two layers; defense in depth applies here too.

### Step 11 — Sampling strategy

100% trace sampling is too expensive at scale; uniform 1% drops rare errors.

Use **tail-based sampling** (a collector processor):

```yaml
processors:
  tail_sampling:
    decision_wait: 5s
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 500 }
      - name: random
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }
```

Result: every error trace is kept. Every slow trace is kept. 5% of normal traces are kept. Storage cost is moderate; signal preservation is high.

Add per-tenant overrides if a specific tenant is being debugged: 100% of their traces for the duration.

### Step 12 — Test alerting end-to-end

Run a chaos test:

1. Inject latency: add `await sleep(800)` in a SIS endpoint. Wait. The latency SLO breach alert fires within minutes.
2. Inject errors: throw 500s on every Nth request. Wait. The error rate alert fires.
3. Stop a service. The service-availability alert fires.

Each test verifies: the alert fires, the runbook is linked, the dashboard shows the symptom clearly.

If any of those don't happen, the observability is theater. Fix it before milestone 1.9.

### Step 13 — Write the ADRs

At least two:
- [`adr/0016-otel-collector-architecture.md`](../adr/) — collector as central pipeline; receivers, processors, exporters; rationale for choosing this over per-service direct export.
- [`adr/0017-slo-and-alerting.md`](../adr/) — initial SLOs (availability + latency) per service, error budget burn-rate alerts, alerting on symptoms not causes.

---

## Definition of done

- [ ] OTel Collector deployed; receivers, processors (including tail sampling + redaction), exporters configured.
- [ ] Tempo, Prometheus, Loki, Grafana running locally and pre-provisioned.
- [ ] All services export traces, metrics, and logs to the collector.
- [ ] `tenant.id` baggage propagates and appears as attribute on every span and log line.
- [ ] RED metrics on every HTTP endpoint and every queue.
- [ ] USE metrics on every Postgres and Redis instance.
- [ ] One operational dashboard answers "is the platform healthy and any one tenant underserved?" — clearly and without explanation.
- [ ] SLOs defined per service (availability + latency); error budget burn-rate alerts configured.
- [ ] Alerts fire on symptoms with linked runbooks; chaos-test confirmed.
- [ ] Structured JSON logging with `trace_id`/`span_id` injection; trace-to-log correlation works in Grafana.
- [ ] PII redaction at collector level; verified by sending a payload with an email and confirming it's stripped/hashed.
- [ ] Tail-based sampling configured; verified that 100% of error traces are kept.
- [ ] ADR-0016 (collector architecture) and ADR-0017 (SLO + alerting) written.

---

## Common pitfalls

1. **Logging what should be a metric.** "User logged in" logged ten thousand times a second is a counter, not a log entry. Loki will groan.
2. **Metric explosions from high-cardinality labels.** `tenant_id` × `route` × `status` × ... — Prometheus will run out of memory. Use exemplars or push tenant-segmented data to traces, not metrics.
3. **Alerting on causes.** "CPU > 80%" pages at 3 AM; you investigate; CPU is fine; service is healthy. Alert fatigue is born.
4. **No runbook on alerts.** A page without a runbook is "wake up and figure it out." Senior engineers write runbooks; mid-level engineers create alerts.
5. **Dashboards built without a question.** A dashboard that no one can articulate the purpose of is wallpaper. Delete it.
6. **Trace context lost across boundaries.** A worker process or background job that doesn't propagate trace context produces orphaned spans. Verify every async boundary preserves context.
7. **Sampling at the service** instead of at the collector. The service makes a sampling decision before any error occurs; later you can't tail-sample because the data is gone.
8. **PII redaction only at the collector.** A log line with an email goes to disk in the application before the collector sees it (e.g., crash dumps). Redact at source AND at collector.
9. **OTel SDK initialized after first import.** Auto-instrumentation requires SDK init before any module that gets instrumented. Same gotcha as milestone 1.0.
10. **Forgetting that observability is itself a dependency.** The collector is critical infrastructure. If the collector is down, your services should not be down. Configure them to drop signals (with logged warnings) rather than block.

---

## Stretch goals (optional rabbit holes)

- **Build a per-tenant deep-dive dashboard.** Given a `tenant_id`, show RED for every service for that tenant, top-N slow endpoints, recent error count, active sagas.
- **Implement error budget burn-rate alerting in full.** Fast burn (1h, 14.4×) and slow burn (6h, 6×) — both at multiple severities.
- **Continuous profiling.** Pyroscope or Parca attached as another OTel exporter. Find CPU and memory hotspots without a separate flow.
- **Build an SLO dashboard** showing every service's SLO compliance for the trailing 7 / 28 days, with burn-rate trends.
- **Run a game day.** Inject failures (kill a service, fill a queue, slow a database) and verify the team's response time and alert quality. Do this even alone — it teaches you what your system actually does under stress.
- **Read *Implementing Service Level Objectives* (Alex Hidalgo)** in full. The most thorough treatment of SLO practice.
- **Open the actual Tempo and Loki APIs** and write a script that queries them programmatically. Senior engineers don't only look through Grafana; they query the data store when needed.

---

## Reflection questions

1. **Three signals, three questions. For each of: traces, metrics, logs — name a concrete operational question that the *other* two cannot answer well.**
2. **You have a metric `http_requests_total{tenant_id, route, method, status}`. With 1,000 tenants and 50 routes, what's the cardinality?** What does this mean for Prometheus storage and query performance?
3. **A customer reports "the site is slow." Walk through your debugging flow using your dashboard.** Where do you look first?
4. **Tail-based sampling at 5% normal + 100% errors. A 1-hour outage produces 100,000 errors. How much trace storage does this consume?** Does that fit your retention budget?
5. **An alert fires at 3 AM. The runbook says "investigate." What's wrong with that runbook?** Rewrite a better one.
6. **The collector is down. What's the user-visible impact?** What's the operator-visible impact? Are they different?
7. **You're hiring a new engineer. They tour your dashboard. What questions can they answer in 5 minutes that they couldn't answer with logs alone?**

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §7 (DevOps & Observability).
- **Google SRE book** and **SRE Workbook**, especially chapters on SLOs, error budgets, alerting on burn rate.
- **Tom Wilkie, *RED Method*** and **Brendan Gregg, *USE Method*** — short, classic.
- **OpenTelemetry collector documentation** — `opentelemetry.io/docs/collector/`. Read the processor reference in detail.
- **Grafana docs**: Tempo, Loki, Prometheus integration — they're well-written.
- **Alex Hidalgo, *Implementing Service Level Objectives*** — the practitioner's book.
- **Charity Majors' blog (`charity.wtf`)** — observability vs monitoring; cardinality; the case for high-context debugging.

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.8 to `Done`. Move to milestone 1.9 (DR drill). The system is now operable; the last milestone proves it's recoverable.
