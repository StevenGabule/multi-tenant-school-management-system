# Phase 2.0 — Production-readiness: closing Phase 1's deferrals

> **Concepts:** pgbackrest + WAL-PITR, Prometheus alert rules with multi-window-multi-burn-rate, Alertmanager + receiver routing, Pact contract tests, k6 load tests, USE metrics for Postgres + Redis, cron-scheduled jobs, bucket lifecycle policies
> **Estimated effort:** 3 weekends — most of it is wiring the pieces Phase 1 named-and-deferred
> **Status:** Not Started
> **Prerequisites:**
> - All Phase 1 milestones complete (you have a system that runs)
> - Re-read each Phase 1 DoD's "deferred to milestone 2.0" lines

---

## What you'll learn

- **pgbackrest** end-to-end: stanzas, repository config, archive_command, full + incremental + diff schedule, PITR with sub-second granularity. The graduation from logical to physical backup.
- **Prometheus alert rules** with the SRE multi-window-multi-burn-rate formalism. Recording rules to keep the alert expressions readable; alert rules with runbook annotations.
- **Alertmanager** routing — grouping, inhibition, silences, receivers (PagerDuty trial / Slack / email). The piece that actually wakes you up.
- **k6 load tests** as code: ramp profiles, SLO thresholds-as-pass/fail, integration with CI.
- **Pact contract tests** in the consumer-driven shape. Producer + consumer roles; broker; CI integration.
- **postgres-exporter / redis-exporter** for USE metrics. The "is the resource saturated?" half of observability.

---

## Why this matters (senior perspective)

Phase 1's milestones honestly noted every deferral. A real production system can't ship with "pgbackrest deferred." Milestone 2.0 is the work that turns "Phase 1 was a learning exercise" into "Phase 1 ships."

The senior posture has three parts:

1. **Deferred ≠ optional.** Every Phase 1 DoD with a "deferred to 2.0" marker had a real reason at the time (scope, sequencing). 2.0 is when those reasons stop being valid.
2. **Alerting that doesn't fire is theater.** Phase 1 set up dashboards; this milestone sets up the pages. The chaos test at the end is the proof.
3. **Contract tests catch what integration tests can't.** Schema drift between services is a class of bug that surfaces at the worst time; Pact catches it at PR time.

---

## Hands-on plan

### Step 1 — pgbackrest replaces pg_dump for DR

Phase 1's `dr-backup.sh` / `dr-restore.sh` stay for the dev quick path; production-grade DR runs through pgbackrest:

1. Install pgbackrest in the Postgres container (or a sidecar).
2. Define a stanza `sms` with repo on MinIO (S3-compat).
3. Configure `archive_mode=on`, `archive_command=pgbackrest --stanza=sms archive-push %p`.
4. Schedule via cron: daily full backup, hourly incremental.
5. Test PITR: take a base, write 100 rows, note timestamp, drop the database, restore to "1 minute ago." Verify 100 rows present.

Update `docs/runbooks/dr-restore.md` Step 3 to use pgbackrest for production restores; keep the pg_dump path documented as the small-DB fast path.

### Step 2 — Alert rules + Alertmanager

Three buckets of rules:

- **SLO recording rules**: numerator (good requests), denominator (total). 30-day window.
- **SLO alert rules**: fast-burn (14.4×, 1h window) + slow-burn (6×, 6h window) for each service's availability + latency SLO. Per ADR-0018.
- **Symptom alerts** beyond SLOs: outbox lag > 30s, saga compensation rate > 5%, registry cache stampede rate > N.

Each alert has:
- A `summary` annotation (one line).
- A `description` annotation (what's happening).
- A `runbook_url` annotation pointing at `docs/runbooks/<alert>.md`.
- A severity label.

Alertmanager routes severity → receiver:
- P0 → PagerDuty (or trial alternative).
- P1 → Slack #incidents.
- P2 → Slack #alerts (low-noise channel).

### Step 3 — Chaos test the alerts

For each alert defined, deliberately cause it to fire:

1. Latency: add `await sleep(800)` to a SIS route, deploy, wait. The latency SLO breach fires within minutes.
2. Errors: throw a `500` on every 5th request. Error rate alert fires.
3. Outbox: stop the relay process. Lag alert fires.
4. Saga: force a step to fail; compensation rate alert fires.

Each alert that fires gets logged + linked to the runbook. Any alert that **doesn't** fire is a bug — fix the rule.

### Step 4 — Pact contract tests

The first contract: `bff-parent` (consumer) ↔ `sis-service` (provider). Pact files committed to a broker (or to the repo with a brokerless flow).

1. BFF consumer test: "I expect GET /api/students to return an array with id/firstName/lastName/dateOfBirth shape." Generates `bff-parent-sis-service.json`.
2. SIS provider verification: a CI job that boots SIS + replays the pact. If SIS's response shape diverges, the verification fails AT SIS'S PR.
3. Extend to bff-parent ↔ academic-service (the GET /api/enrollments contract).

The win: a SIS engineer can no longer rename `firstName` → `givenName` without breaking SIS's CI.

### Step 5 — k6 load test on the BFF

A k6 script that hits `/api/me/dashboard` at 50 RPS for 5 minutes, with the SLO as a threshold:

```javascript
export const options = {
  stages: [{ duration: '1m', target: 50 }, { duration: '4m', target: 50 }],
  thresholds: {
    http_req_duration: ['p(99)<500'],
    http_req_failed: ['rate<0.01'],
  },
};
```

Run on a fresh seeded database (parent with 3 children, 5 enrollments each). Threshold breach fails the test. CI gate: this test must pass before any BFF PR merges.

### Step 6 — USE metrics for Postgres + Redis

Wire postgres-exporter + redis-exporter into the docker-compose. Both scrape via Prometheus. Add a second Grafana dashboard: "Resource health" with:

- Postgres: connections used / max, transaction rate, lock waits, buffer cache hit ratio, replication lag (when there's a replica).
- Redis: used memory / max, blocked clients, hit ratio, evicted keys.

This dashboard answers "is a resource saturated?" — the U + S of USE. Errors come from logs.

### Step 7 — Cron-scheduled backups + 35-day lifecycle

Two pieces:

1. A compose-cron sidecar (or k8s CronJob) that runs `dr-backup.sh` / pgbackrest daily.
2. MinIO bucket lifecycle: expire objects in `base/`, `wal/`, `per-tenant/` after 35 days. Use `mc ilm import` from a YAML.

Verify by manually rewinding a backup's mtime and confirming it gets swept.

### Step 8 — Per-queue + saga RED metrics

The metrics the milestone-1.8 DoD named-and-deferred:

- **Outbox**: lag (`max(processedAt is null) - now`), throughput (events/sec processed), error rate.
- **Saga executor**: active saga count by status, step duration p50/p95, compensation rate.
- **BFF cache**: hit rate, miss rate, eviction rate.

Each emitted via OTel `meter.createCounter` / `createHistogram` in the service code. The platform-overview dashboard gains a third row.

### Step 9 — ADRs

At least two:
- `adr/0021-alerting-routing-strategy.md` — Alertmanager severity routing, why PagerDuty/Slack/email split this way.
- `adr/0022-contract-testing-with-pact.md` — Pact vs schema-first OpenAPI; the broker decision; how breaking changes are surfaced.

---

## Definition of done

- [ ] pgbackrest replaces pg_dump for production DR. PITR verified end-to-end.
- [ ] Prometheus recording rules + alert rules (fast-burn + slow-burn) for each service's availability + latency SLO.
- [ ] Alertmanager routes P0/P1/P2 to distinct receivers. Each alert has a `runbook_url` annotation.
- [ ] Chaos test fires every alert. Any alert that doesn't fire is fixed.
- [ ] Pact contract tests wired between bff-parent and sis-service + academic-service. Breaking provider change fails provider CI.
- [ ] k6 load test on /me/dashboard at 50 RPS passes the latency + error SLO. Wired into CI.
- [ ] postgres-exporter + redis-exporter feeding Prometheus. Resource-health dashboard committed.
- [ ] Cron-scheduled daily backups. 35-day bucket lifecycle policy active and verified.
- [ ] Outbox + saga + BFF cache RED metrics emitting. Platform-overview dashboard updated.
- [ ] ADR-0021 (alerting routing) and ADR-0022 (contract testing) written.

---

## Reflection questions

1. **Why did Phase 1 defer pgbackrest?** Walk through the trade-off. What conditions made it the right call THEN, and what changed for THIS milestone?
2. **A fast-burn alert fires at 14:32. Walk through the operator response.** What's in the runbook? What's the first command?
3. **A consumer Pact says SIS returns `firstName`. SIS renames it to `givenName`. The provider verification fails — what does the SIS engineer do?**
4. **You run the chaos test. One alert never fires. What was the bug — in the rule, in the symptom, or in your assumption?**
5. **The 35-day lifecycle expires a backup that was the last clean copy before a corruption. What's the recovery path?**

---

## References

- pgbackrest user guide: <https://pgbackrest.org/user-guide.html>
- SRE Workbook chapter on burn-rate alerting: <https://sre.google/workbook/alerting-on-slos/>
- Pact docs: <https://docs.pact.io/>
- k6 docs: <https://k6.io/docs/>
- Internal:
  - All Phase 1 milestone DoDs (search for "deferred to milestone 2.0")
  - `docs/adr/0019-backup-strategy.md` (the pgbackrest graduation triggers)
  - `docs/adr/0018-slo-and-alerting.md` (the alerting formalism)
- Phase 1.9 milestone: [`../phase-1/09-dr-drill.md`](../phase-1/09-dr-drill.md)
