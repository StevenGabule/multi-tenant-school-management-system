# Phase 2.7 — Capstone: multi-region failover drill

> **Concepts:** the cold drill repeated at a larger blast radius, region failure modes, customer-visible failover behavior, cross-region RPO/RTO, data residency invariants under stress, the tabletop-then-cold drill cadence
> **Estimated effort:** 2 weekends — most of it is the drill itself
> **Estimated effort, future cadence:** quarterly
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 2.0–2.6 complete (you can't fail over what isn't running multi-region with full observability)
> - Re-read Phase 1.9 (the drill discipline) and ADR-0020 (DR tier targets)

---

## What you'll learn

- The same things you learned in milestone 1.9, but at the next blast radius: an entire region's loss, not a database's. The discipline is identical; the surface is larger.
- **Tabletop first, cold drill second.** A multi-region failover risks customer-visible impact even in a drill. The tabletop (a walk-through with the runbook + a whiteboard) precedes the cold drill by 1–2 weeks.
- **The cross-region staleness window.** The secondary's WAL replay is ~seconds behind. Any session that committed in the last N seconds before failover is lost. The customer email template names this honestly.
- **Data residency under stress.** A US tenant's session that fails over to the EU region is, technically, EU-resident now. The runbook says: no it isn't — the failover is to a US-secondary that exists for this reason. Practice catches the assumptions.
- **The recover-to-primary problem.** Failover is half the story; failing BACK is harder. The runbook documents both directions.

---

## Why this matters (senior perspective)

Milestone 1.9 taught the drill at the database level. This milestone scales it to "we lost a region." Most teams claim multi-region; few have ever exercised the failover. The Phase 2 capstone is the proof that the Phase 2 milestones earn their keep.

The senior posture has three parts:

1. **The drill is the proof.** Multi-region without a tested failover is theater. Customers who paid for multi-region SLAs get the drill records on request.
2. **The tabletop is the cheap drill.** A real cold drill costs customer disruption (even a planned one). The tabletop costs an afternoon. Tabletops 3:1 with cold drills, minimum.
3. **The recover-to-primary is the senior test.** Failover is well-rehearsed; failing back is when the assumptions surface (cross-region replication caught up? auth sessions need a flush? clients cached the old region?).

---

## Hands-on plan

### Step 1 — Tabletop

A 2-hour session — alone, or with anyone else around — walking through the runbook against a scenario:

> Scenario: At 14:00 UTC, our cloud provider's status page shows us-east-1 is degraded. Our internal monitoring confirms: api.school.example is 503-ing for US tenants. EU tenants are unaffected. The decision tree begins.

Walk through every runbook step. Mark gaps. Common gaps the tabletop finds:

- "Step 4 says update DNS. Whose DNS account is it? Who has the credentials?"
- "Step 7 says verify data residency invariants. Where's the query that proves them?"
- "Step 9 says recover-to-primary when the region returns. How do we know it's actually safe?"

The tabletop's output is an updated runbook. Cold drill follows in 1–2 weeks.

### Step 2 — Cold drill setup

Plan the drill for a Tuesday afternoon (the milestone-1.9 rule applies). Communicate:

- Internal: post in #incidents, "Planned drill, 14:00 UTC, expected 20-min impact on staging-only US tenants. Production unaffected."
- External (if real customers exist on the staging tier — Phase 3): customer email a week prior + an opt-out window.

Pre-drill snapshot:
- US region's tenant count + last write timestamp per tenant.
- Active sessions count.
- The platform-overview dashboard's last-30-min screenshot (baseline).

### Step 3 — Execute the drill

Trigger the region failure:

```bash
# Phase 2 cluster: cordon the US region's worker nodes
kubectl --context sms-us cordon --all
kubectl --context sms-us drain --all --ignore-daemonsets --delete-emptydir-data
```

The US region is now effectively down. The clock starts.

Follow the runbook:

1. Confirm the failure via multi-source check.
2. Promote the EU's US-secondary replica to primary.
3. Update DNS to route US tenant traffic to the EU's US-secondary.
4. Verify: US tenants can log in + read their data; data residency invariants hold (their data is in the US-secondary, which is geographically US per the configuration even though the kubernetes cluster is EU-region).
5. Resume traffic.
6. Stop the clock. Record actual RTO.

### Step 4 — Verify under load

While "failed over," exercise the system:

- Log in as a parent.
- Pay tuition.
- Mark attendance (event-sourced — the event stream's writes go to the now-primary US-secondary).
- The BFF should respond; the dashboard should render; the payment should settle.

Any failure here is a finding. Some are expected (the dashboard's cached layer might serve stale data for 30s); some are bugs (the saga executor can't write because it's pointing at the dead primary's connection string).

### Step 5 — Fail back

The harder half:

1. Cloud provider declares us-east-1 healthy.
2. Application traffic still on EU's US-secondary.
3. Plan the failback:
   - Catch up the original US primary's WAL from the EU's US-secondary (which became primary during failover).
   - Schedule a maintenance window (10–15 min).
   - During the window: stop writes on the EU side; verify catch-up complete; flip DNS back; re-promote the original US primary to writable.
   - Resume.
4. Stop the clock. Record failback RTO.

### Step 6 — Post-mortem

Same format as milestone 1.9's drill #1 post-mortem. Three issues found (this is the rule, not the suggestion):

Likely candidates from a multi-region drill:
- DNS TTL was too long; clients held the stale resolution for 12 minutes.
- A service's connection string was hard-coded to the US primary; pod restart loop until manually edited.
- The BFF's Redis cache was regional; cache cleared correctly but cold-start latency spiked.

Document each, owner, fix-by-date. Update the runbook. Update ADR-0020's measured RTO/RPO columns.

### Step 7 — Schedule the next drill

Quarterly. The calendar entry is the artifact (per milestone 1.9's win-condition lesson).

### Step 8 — ADRs

- `adr/0036-failover-procedure.md` — the runbook, codified. The DNS strategy. The data-residency-during-failover invariant.
- `adr/0037-rto-rpo-measured-multi-region.md` — the cross-region numbers from the drill. Updates ADR-0020 if numbers changed.

---

## Definition of done

- [ ] Tabletop run; runbook updated with at least 3 gaps closed.
- [ ] Cold drill executed: US region cordoned; EU's US-secondary promoted; traffic resumed.
- [ ] Actual cross-region RTO + RPO measured and recorded.
- [ ] Smoke test under failover: parent log in, payment, attendance — all work.
- [ ] Failback executed; original US primary writable again; data converged.
- [ ] Post-mortem written with ≥3 issues + fixes.
- [ ] `docs/runbooks/region-failover.md` updated against findings.
- [ ] ADR-0036 (failover procedure) and ADR-0037 (cross-region RTO/RPO) written.
- [ ] Next drill scheduled (calendar entry, quarterly cadence).

---

## Reflection questions

1. **The tabletop revealed that step 4 of the runbook depends on credentials in 1Password. 1Password is fine, but who has access? What's the bus factor?**
2. **During the drill, a US parent's session was redirected to the EU's US-secondary. They were logged in but couldn't complete a payment for 30 seconds. What was the failure, and where in the runbook would you note it?**
3. **Failback succeeded but a small number of journal entries from the failover window are duplicated. What's the resolution?**
4. **The drill's measured RTO is 18 minutes. The contractual RTO is 15. What changes? (Three answers: tooling, runbook, customer comms.)**
5. **A customer asks: "show me you can fail over." What's the evidence package?**

---

## References

- Google SRE Workbook, *Disaster Recovery Testing* — the chapter on chaos drills as continuous validation
- AWS Well-Architected Framework, *Reliability pillar — recovery testing* section
- The Phoenix Project (fiction) — for the DR scenes
- Internal:
  - `docs/runbooks/dr-restore.md` — Phase 1's drill, conceptual parent
  - `docs/postmortems/2026-05-10-cold-drill-1.md` — the format this milestone follows
  - `docs/adr/0020-dr-tier-targets.md` — the per-tier RPO/RTO this milestone validates
  - `docs/phase-2/01-multi-region.md` — the architecture being drilled
