# Phase 2.1 — Multi-region deployment + data residency

> **Concepts:** active-passive vs active-active replication, region-pinned tenants, region routing at the gateway, data-residency enforcement, DNS failover, the GDPR/FERPA cross-border bind
> **Estimated effort:** 4 weekends — multi-region is genuinely deep
> **Status:** Not Started
> **Prerequisites:**
> - Milestone 2.0 complete (alerting + pgbackrest are non-negotiable for multi-region)
> - Re-read the original architecture document's §5 (regions + residency)

---

## What you'll learn

- The semantic difference between **multi-region** (your system runs in two regions) and **active-active** (writes accepted in both regions concurrently). Most multi-region claims are actually active-passive.
- **Region routing**: the tenant's region metadata (from the registry, ADR-0007) drives request routing. A US tenant's request that arrives in the EU region is rejected, not silently served — *especially* not silently.
- **Data residency** as a regulatory invariant. GDPR, FERPA, India's DPDP — each names which data can leave which jurisdiction. The system must enforce this structurally, not "by policy."
- **DNS-based failover** vs anycast vs application-routed. The Phase 2 choice is region-aware DNS; Phase 3 may add anycast.
- **WAL streaming across regions** for the read-replica path. The asynchronous nature; the staleness window.
- **The cross-region clock skew problem**: Postgres timestamps from two regions are NOT comparable without NTP discipline. Saga steps that span regions need monotonic event-id ordering, not wall-clock.

---

## Why this matters (senior perspective)

A single-region system can be operationally excellent and still lose to a region outage. AWS us-east-1 has gone fully dark for hours twice in five years; GCP and Azure have similar history. A school management system serving a district can't be "down for 4 hours because Amazon" in 2026 — the contract assumes better.

The senior posture has three parts:

1. **Active-passive is a real architecture, not a hack.** "Active-active" is what every vendor markets; "active-passive with measured failover" is what most run. The honest answer is rarely the impressive one.
2. **Data residency is a hard line, not a goal.** A US tenant's data must NEVER live in EU storage, not even transiently. The enforcement is at the data plane, not at the request layer — Postgres in the EU region cannot, by network policy, talk to US tenant data.
3. **Failover is a tested procedure, not a button.** Milestone 1.9 taught the discipline. The multi-region failover drill (milestone 2.7) is the Phase 2 capstone — same discipline, larger scope.

---

## Hands-on plan

### Step 1 — Two-region deployment

For local learning, "regions" are two docker-compose stacks on different host ports:

- `sms-us` (primary): postgres, keycloak, all services. Tenants `region=us`.
- `sms-eu` (secondary): postgres-replica (streaming), keycloak (federated to primary), services in standby. Tenants `region=eu`.

In production: AWS regions or k8s clusters in different AZs/regions.

### Step 2 — Tenant region metadata

The tenant-registry's tenant model already has a `region` field (ADR-0007). Now make it load-bearing:

- The gateway, on every request, resolves the tenant from the JWT's `tenant_id` claim, fetches `tenant.region`, and compares against the region this gateway is running in.
- Mismatch → 421 Misdirected Request with the correct region in the response.
- Match → continue.

This is the first time the registry's region field affects request handling. Cross-tenant tests gain a "tenant in wrong region returns 421" scenario.

### Step 3 — Region routing at DNS

Cloud DNS (Route 53, Cloud DNS) supports geo-routing. A `us-tenant.school.example` resolves to the US gateway; an `eu-tenant.school.example` to the EU one. For local dev: a fake DNS layer at the edge, or hostname-based routing in the gateway.

For Phase 2 simplicity, the BFF / clients learn their region from the JWT and route accordingly. A real frontend would discover the region via a `well-known` endpoint at first login.

### Step 4 — Postgres streaming replication for read-after-write within region

Each region has its own writable primary. Within the region, a streaming replica serves reads (the BFF's `GET` endpoints can go to either).

Cross-region replication is NOT bidirectional in Phase 2:
- The primary region runs full reads + writes for its tenants.
- The secondary region runs reads + writes for ITS tenants AND a DR-replica of the primary's WAL (for failover).
- Tenants in region A do not have their data in region B's writable cluster (data residency).

### Step 5 — Data residency enforcement

Three layers of defense:

- **Network**: VPC peering between regions is one-way (for WAL replication only); application traffic between regions is blocked at the security group level.
- **Application**: the gateway's 421 response for wrong-region requests.
- **Storage**: backup buckets are regional. A US tenant's backups live in `us-east-1` S3; EU's in `eu-west-1`. Cross-region replication is OPT-IN per tenant, not default.

A cross-tenant test gains a "writing as a US tenant to the EU database is impossible by network policy."

### Step 6 — Failover procedure (drill follows in 2.7)

Document the manual failover steps:

1. Confirm primary region is down (multi-source: Pingdom, internal probe, customer reports).
2. Promote the secondary's replica to primary. WAL apply stops; the replica becomes writable.
3. Update DNS to point the primary's region at the secondary.
4. Take application-level inventory: what tenants are now operating in their non-home region?
5. Resume traffic.
6. Plan the "fail back" once the primary returns — usually a controlled migration, not an automatic flip.

### Step 7 — ADRs

- `adr/0023-active-passive-multi-region.md` — why active-passive over active-active for Phase 2.
- `adr/0024-region-routing-and-residency.md` — the 421-on-wrong-region rule, network-layer enforcement, the cross-border data flow exceptions (none in Phase 2).

---

## Definition of done

- [ ] Two regional stacks (sms-us, sms-eu) running concurrently.
- [ ] Tenant registry's `region` field drives gateway routing decisions.
- [ ] Cross-region request returns 421 Misdirected Request (or equivalent), with the correct region in the response.
- [ ] Within-region streaming replica serves reads.
- [ ] Cross-region WAL streaming for DR (read-only replica in secondary).
- [ ] Network policy blocks application traffic between regions (only WAL allowed).
- [ ] Per-region backup buckets. No cross-region copy by default.
- [ ] Cross-tenant test extended: "writing as a tenant whose region is X to region Y's gateway is rejected."
- [ ] Documented manual failover procedure in `docs/runbooks/region-failover.md`.
- [ ] ADR-0023 (active-passive) and ADR-0024 (region routing + residency) written.

---

## Reflection questions

1. **Why active-passive, not active-active?** Walk through the multi-master write conflict problem and how Phase 2 sidesteps it.
2. **A tenant's region changes (rare; e.g., they move HQ). What's the data migration shape, and what's its downtime profile?**
3. **A US tenant sends a request to the EU gateway. The 421 response includes the correct region. How does the client behave? What's the worst case?**
4. **A regulator audits and asks "is my country's tenant data in my country?" — what's the evidence?**
5. **The secondary region's read-replica is 90 seconds behind. A parent enrolls a child via the primary, then their BFF reads from the secondary's replica. What does the user see?**

---

## References

- AWS Well-Architected Framework — Reliability pillar, multi-region patterns
- "How to think about multi-region" — various engineering blog posts; the consensus is "active-passive until you can't"
- Postgres streaming replication: <https://www.postgresql.org/docs/16/warm-standby.html>
- HTTP 421 Misdirected Request (RFC 7540 §9.1.2)
- Internal:
  - `docs/adr/0007-control-plane-db-strategy.md` — the tenant registry that owns region metadata
  - `docs/adr/0020-dr-tier-targets.md` — the per-tier RPO/RTO targets multi-region tightens
- Capstone: [`07-multi-region-drill.md`](07-multi-region-drill.md)
