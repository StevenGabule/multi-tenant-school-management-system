# ADR-0020: DR tier targets — measured, not claimed

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Every customer contract has RPO/RTO numbers. Most don't correspond to
reality. The gap between claimed and measured is what cold drills
expose — and what the senior posture commits to closing.

Milestone 1.9 ran cold drill #1 (2026-05-10). This ADR records the
measured numbers, the conditions under which we tighten them, and the
per-tier differentiation we already plan for.

The tenancy tiers (per ADR-0001) are pool, bridge, silo. Each has
different DR economics:

- **Pool**: shared Postgres + RLS. Restore is whole-cluster; RPO/RTO
  are cluster-wide.
- **Bridge**: schema-per-tenant in a shared cluster. Same DR profile
  as pool; restore-by-tenant via per-tenant logical backup is the
  feature pool tier doesn't promise.
- **Silo**: per-tenant cluster. Independent backups, independent
  restore, independent crypto-shred. Better RPO/RTO but expensive.

## Decision

**Phase 1 ships measured RPO + RTO numbers per tier, with explicit
graduation triggers for tightening. The numbers are derived from the
actual drill, not from aspiration.**

### Tier targets (Phase 1)

| Metric | Pool | Bridge (planned) | Silo (planned) |
|---|---|---|---|
| **RPO** | 24h (nightly base backup; pg_dump-only) | 24h | **5min** when productized |
| **RTO** (small DB, ~MB) | 30min | 30min | 15min |
| **RTO** (production, GB-scale) | 90min¹ | 90min¹ | 30min |
| **GDPR-compliant deletion** | 35-day window | 35-day window | **immediate via crypto-shred** |
| **Tested per quarter** | Yes (drill cadence) | TBD on productization | TBD on productization |

¹ Linear extrapolation from drill #1 (~4s for ~24 rows). Real
production verification is part of drill #2.

### Drill #1 measured values

- **Actual RPO** during drill: 8 seconds (drill artifact — backup
  taken seconds before the drop).
- **Production-mode RPO** under the same tooling: **bound by backup
  cadence**. Daily backup → ~24h worst case. WAL replay is not part
  of the Phase-1 toolchain (ADR-0019).
- **Actual RTO**: ~3 minutes from drop to verified-query-passes,
  including the time to discover and fix the missing-grants issue.
- **Hardened RTO target** (post-drill-1 fixes applied): ~5 minutes
  for an MB-scale database. The target tightens with the runbook
  hardening; drill #2 verifies.

### Graduation triggers — when targets tighten

We commit to evaluating tighter RPO/RTO when ANY of these become true:

  1. **A customer SLA names a tighter RPO.** A 1-hour RPO requires
     pgbackrest with hourly base + WAL archiving (ADR-0019 trigger
     #1). A 5-minute RPO requires streaming replication.

  2. **A customer SLA names a tighter RTO.** A 15-minute RTO at
     production scale requires a hot standby — restore time becomes
     "promote replica," seconds.

  3. **The platform crosses 100 paying tenants.** Per-tenant restore
     becomes a routine support task (one tenant's data needs to be
     rolled back to last week). Phase 3 silo productization is the
     proper answer.

  4. **An incident response actually invokes the runbook.** Real
     incident teaches things drill cannot. The numbers re-baseline.

  5. **A regulator requires demonstrable per-tenant deletion within
     a window** (e.g., 30 days for GDPR Art-17). Crypto-shred for
     silo tenants becomes a productized feature, not a preview.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **No published targets** | No commitment; operations evolve organically | Customers ask for SLAs and we have nothing to defend; engineers don't know what to test against | Default trap; "we'll figure it out" doesn't survive a real incident |
| **Aspirational targets ("99.99% / 5 minutes")** | Looks good on a slide | Drift from reality; first incident exposes the lie | Senior engineers commit to defended numbers, not slogans |
| **Measured targets, per-tier (chosen)** | Honest; defensible; Inform engineering priorities (a tighter RPO target IS a budget for pgbackrest work) | Requires actual drill discipline; numbers may embarrass us until pgbackrest lands | n/a — the senior pattern |
| **Tier-blind single SLA** | Simpler to communicate | Pool and silo customers pay different prices; promising the same SLA is either too cheap for silo or too aspirational for pool | Pricing ↔ DR has to be tier-aware |

## Consequences

**Positive:**

- The numbers are defensible. "Our pool RPO is 24h" is true and
  comes with a recorded drill that shows how. Sales/customers know
  exactly what they're getting; engineering knows exactly what
  they're committing to.
- The graduation triggers turn DR investment into a customer-driven
  decision. We don't ship pgbackrest because it's the next shiny
  tool; we ship it when a customer SLA, an incident, or a tenant
  count requires it.
- Per-tier differentiation matches the tenancy + pricing model
  (ADR-0001). Customers paying for silo get demonstrable DR
  advantages, not just "their own database."
- The drill cadence (quarterly) keeps the numbers honest. A drill
  that fails to meet the target is a re-baselining event, not a
  catastrophe.

**Negative / costs:**

- The current pool RPO is unflattering. 24h is far worse than what
  managed RDS achieves out of the box. Mitigation: pgbackrest is
  in the milestone-2.0 backlog; the gap is documented + has a
  trigger.
- Numbers requires discipline to maintain. Without quarterly
  drills, the post-mortem cycle, and the runbook updates, the
  numbers drift back to aspiration.
- A multi-tenant production incident affects all tenants, regardless
  of tier — the silo customer's "their own database" doesn't help
  if a shared bug brought everything down.

**Risks:**

- **A customer signs the published numbers, then a real incident
  breaches them.** Mitigation: the numbers are conservative
  (pessimistic upper bounds); the drill measures lower numbers;
  the gap absorbs incident variance.
- **Drill cadence slips.** A missed quarter = the runbook rots,
  numbers drift. Mitigation: calendar entries with hard ownership;
  documented as the milestone-1.9 win condition.
- **Engineers optimize for the number, not for resilience.** "We
  hit 28 minutes RTO" doesn't mean the system is robust. Mitigation:
  the post-mortem is the real artifact; the number is the proxy.

**Follow-up work this enables / forces:**

- Drill #2 (2026-08-10): re-measure post-fixes, plus cross-cluster
  restore + larger volume. New numbers feed back into this ADR.
- Milestone 2.0: if a graduation trigger fired, pgbackrest +
  WAL-PITR brings RPO to minutes; runbook + ADR-0019 update.
- Phase 3: silo productization makes the silo column real.
- Phase 4 (the multi-region story, post-Phase-1 backlog): cross-region
  RPO becomes a thing, with the further drill cadence ramp.

## References

- Google SRE Workbook, *Disaster Recovery Testing* — the cadence +
  measurement discipline.
- AWS Well-Architected Framework, Reliability pillar — the per-tier
  DR maturity model.
- GDPR Art. 17 — the regulatory underpinning of crypto-shred.
- Internal:
  - `docs/postmortems/2026-05-10-cold-drill-1.md` — the measured
    numbers this ADR codifies
  - `docs/runbooks/dr-restore.md` — the procedure the targets
    measure against
- Phase 1.9 milestone: [`../phase-1/09-dr-drill.md`](../phase-1/09-dr-drill.md)
- Related: [ADR-0019](0019-backup-strategy.md) (the tooling that
  produces the measured numbers)
- Related: [ADR-0001](0001-tenancy-tier-model.md) (the tier
  differentiation this ADR's per-tier targets reflect)
