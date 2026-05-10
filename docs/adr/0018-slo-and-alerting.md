# ADR-0018: SLOs, error budgets, and alerting on symptoms

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Milestone 1.8 stands up the observability stack. The next architectural
question — once the data is flowing — is **what do we measure, what do
we alert on, and how do we tell signal from noise?**

The naive default is "alert on everything that looks bad." CPU > 80%.
Memory > 70%. Disk > 90%. p99 > 500ms. Error rate > 0.1%. Each
threshold seems sensible alone; together they fire constantly, train
operators to ignore alerts, and make the next real outage harder to
catch.

The Google SRE Workbook articulates the alternative: **SLOs and
error budgets**. Define what the user-visible promise is; measure
compliance; alert when the budget is burning fast enough to deplete
before next month's reset.

## Decision

**We adopt SLO-driven alerting per the Google SRE Workbook formalism.
Every service has a numeric availability SLO + a numeric latency SLO,
with explicit error budgets and burn-rate alerts. Alerts fire on
symptoms (user-visible badness), never on causes (high CPU, low disk).**

### Specific rules

1. **Each service has TWO SLOs:**
   - **Availability**: 99.9% over a rolling 30-day window.
     Error budget: 0.1% × 30 days = 43 minutes/month.
   - **Latency**: p99 < 500ms for HTTP server spans.
     Error budget: minutes-where-p99-exceeds-500ms / total-minutes.

2. **Burn-rate alerts (Google SRE Workbook formalism):**
   - **Fast burn** — 5% of monthly budget consumed in 1 hour
     = 14.4× normal burn rate. Page immediately. Symptom: outage in
     progress.
   - **Slow burn** — 10% of monthly budget consumed in 6 hours
     = 6× normal burn rate. Page during business hours. Symptom:
     creeping degradation that won't show up on a "p99 > 500ms for
     5 minutes" alert.

3. **Symptom-based alerts only. Cause-based alerts banned.**
   The list of allowed paging conditions:
   - User-visible: SLO burn rate, error rate spike, latency spike.
   - Workflow-visible: saga compensation rate > 5%, outbox lag >
     30s, queue depth > N for > 5 min.
   - Identity-visible: 401/403 rate spike (auth misconfig).
   The list of banned paging conditions:
   - Resource utilization (CPU, memory, disk) — these inform
     dashboards, never page.
   - Health-check failure for >1 instance of a multi-instance
     service — page only when the service-level SLO breaches.
   - Container restart count — investigate; don't wake.

4. **Every alert ships with a runbook.** The runbook lives in the
   alert annotation (Grafana / Alertmanager support this). It says
   what the alert means, what the operator should check first, and
   the rollback steps if applicable. An alert that says "investigate"
   is hostile to the operator.

5. **Severities:**
   - **P0 (page-now)**: SLO fast-burn, total platform outage,
     auth/identity total failure. Wakes someone up.
   - **P1 (next morning)**: SLO slow-burn, single-tenant outage,
     dependency degradation. Email + dashboard.
   - **P2 (ticket)**: drift signals, capacity warnings. Logged.

6. **Silence windows are first-class.** Deploys silence the
   relevant alerts for 10 min (deploy-induced spikes are noise). Game
   days silence everything. Manual silences require an expiry.

### Phase 1.8 status of these rules

The formalism is documented and the dashboard is in place. Burn-rate
alerts are NOT yet wired — that requires Prometheus alerting rules +
Alertmanager + receiver configuration (PagerDuty, Slack, etc.).
Documented as deferred to milestone 2.0 alongside the rest of the
production-readiness milestone.

What IS wired today:
- Latency, error rate, request rate metrics per service via Tempo's
  metrics-generator (`sms_traces_spanmetrics_*`).
- Per-tenant request rate + error rate (the multi-tenant top-N panel).
- The dashboard color-codes the SLO thresholds (green < 0.3s p99,
  yellow < 0.5s, red ≥ 0.5s) so the symptom is visible.

What's NOT wired (Phase 2):
- Burn-rate alert rules in Prometheus (`record:` recording rules +
  `alert:` rules with the multi-window-multi-burn-rate formalism).
- Alertmanager + receiver routing.
- Runbook annotations on each alert.
- Silence-window automation tied to deploys.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **No formal SLOs** | Zero work; alert when something feels off | Alert fatigue; reactive operations; no shared definition of "healthy" | The default trap — operators learn to ignore the wallpaper |
| **Threshold alerts only ("p99 > X for 5 min")** | Simple to write; understandable | Misses creeping regressions (an error rate that doubles each day for a week never crosses the threshold for 5 min); fires on transient blips | Reactive without informing |
| **SLO + burn-rate alerts (chosen)** | Catches both spikes and creep; aligns alert sensitivity with budget; has industry consensus (Google SRE Workbook) | Requires baseline measurement; multi-window multi-burn-rate is non-trivial to configure; burn-rate rules are PromQL-heavy | n/a — the senior pattern |
| **Anomaly detection (ML on metrics)** | Catches subtle patterns; less manual config | False positives high; explainability low; requires training data we don't have | Right answer at scale 100× ours |

## Consequences

**Positive:**

- The dashboard's color thresholds align with the SLO. An operator
  glancing at the dashboard sees "green / yellow / red" mapped to the
  same numbers the alerts fire on. No mental conversion.
- The error budget framing turns "we can't ship faster, ops will
  yell" into "we have 43 minutes of budget; if we burn it on this
  feature's risk, we slow down deploys until it resets." Cultural
  benefit beyond the math.
- New services adopt the same shape. `bff-parent` has its own
  availability + latency SLO; the burn-rate alert rule is a copy-paste
  with the service name changed.
- Symptom-based alerts mean operators trust the page. When P0 fires,
  they know users are affected — no "ah, just CPU again."

**Negative / costs:**

- Burn-rate math is non-trivial to teach a junior engineer. The
  multi-window-multi-burn-rate PromQL is dense. Mitigation: this ADR
  + the SRE Workbook + a runbook per alert.
- SLO targets require historical data to set defensibly. Phase 1's
  99.9% / 500ms are starting numbers; Phase 2 should re-baseline
  against actual traffic.
- Phase 1.8 doesn't ship the alerts themselves. Documented as
  deferred; risk is "the dashboard exists but no one is paged."
  Acceptable for a learning project + dev environment; production
  graduation requires the alert wiring.

**Risks:**

- **An over-tight SLO traps the team.** 99.99% latency requires
  expensive redundancy that may not match the value of the service.
  Mitigation: each SLO is reviewed quarterly against business need.
- **An under-tight SLO becomes meaningless.** 99% over 30 days
  = 7+ hours of allowable outage; users will scream long before the
  budget burns. Mitigation: the 99.9% / 43min number is a defensible
  starting point.
- **Alert fatigue from a noisy SLO.** A new service with unstable
  metrics fires fast-burn alerts daily; operators learn to ignore.
  Mitigation: "warm-up window" of 7 days before SLO alerts fire on a
  new service; ad-hoc dashboards instead.
- **Cause-based alerts sneak in.** A future engineer adds "memory >
  90% for 10 min". Mitigation: code-review every Alertmanager rule
  PR against the symptom-vs-cause discipline; this ADR linked.

**Follow-up work this enables / forces:**

- Milestone 2.0 (production readiness): wire the burn-rate alert
  rules. Recording rules for the SLO numerator/denominator; alert
  rules for fast-burn + slow-burn at multiple severities;
  Alertmanager + receivers (PagerDuty trial, Slack for non-urgent).
- Milestone 2.0: chaos test — inject latency, errors, dependency
  failures; verify the alerts fire AND the runbooks point at the
  right rollback. Per the milestone-1.8 doc: "if any of those don't
  happen, the observability is theater."
- Phase 2: `bff-parent` and `bff-admin` (when it exists) get persona-
  specific SLOs. The dashboard at the parent layer differs from the
  service layer.
- Phase 3: SLO graduation — when a service has 6 months of stable
  data, re-tune the targets. Probably tighter (99.95% / 300ms is
  often achievable for read paths).

## References

- Google SRE Workbook, *Implementing SLOs* and *Alerting on SLOs*:
  <https://sre.google/workbook/implementing-slos/>
- Alex Hidalgo, *Implementing Service Level Objectives* (2020) — the
  practitioner's deep dive.
- Charity Majors, *Observability vs Monitoring*: cardinality discipline
  and the case for high-context debugging.
- The multi-window-multi-burn-rate formalism: SRE Workbook chapter
  *Alerting on SLOs*, specifically the table of (window, threshold,
  severity) combinations.
- Internal:
  - `infra/observability/grafana/provisioning/dashboards/platform-overview.json`
    — color thresholds align with the SLO numbers
  - `infra/observability/collector/config.yaml` — tail-sampling keeps
    100% of trace data for SLO-affecting requests
- Phase 1.8 milestone: [`../phase-1/08-observability.md`](../phase-1/08-observability.md)
- Related: [ADR-0017](0017-otel-collector-architecture.md) (the
  pipeline that produces the metrics this ADR alerts on)
