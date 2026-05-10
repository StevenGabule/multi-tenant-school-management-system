# Phase 1.9 — DR drill

> **Concepts:** disaster recovery vs backup, RPO and RTO measured (not claimed), continuous WAL archiving, point-in-time recovery (PITR), per-tenant logical backups, backup encryption with KMS, runbook discipline, the cold drill, the post-mortem culture
> **Estimated effort:** 2–3 weekends — most of it is the drill itself, not the setup
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 1.0–1.8 complete (you have a system worth recovering)
> - Read [`../../documentation.md`](../../documentation.md) §7 (DR per tier subsection)
> - Glance at AWS RDS PITR docs and the Postgres `Continuous Archiving` chapter

---

## What you'll learn

- The semantic difference between **backup** (copy of data) and **disaster recovery** (the practice of returning to operation after loss). Most teams have backups; few have DR.
- **RPO** (Recovery Point Objective — how much data can you lose) and **RTO** (Recovery Time Objective — how long can you be down) — and the distinction between *claimed* and *measured*. The number on the spec sheet is meaningless until you've validated it under drill conditions.
- **Continuous WAL archiving** in Postgres: what's actually shipped, where, how it's combined with base backups for point-in-time recovery.
- **Per-tenant logical backups** vs full-cluster physical backups: when each is right and how the silo tier eventually gets per-tenant recovery as a feature.
- **Backup encryption** with KMS: the key hierarchy, the failure modes (revoked keys, key region mismatch), and the crypto-shredding pattern for tenant data deletion.
- **Runbook discipline**: the difference between a *runbook* (steps that have been tested cold) and a *wishbook* (steps that look reasonable but no one has run). The cold drill is the only thing that turns one into the other.
- **The first-drill rule**: every first drill finds three things broken. The lesson is in finding them, not in the smoothness of the drill.
- **GDPR backup retention** as a compliance constraint: if you delete a user, the backup must eventually expire, or restore resurrects deleted data.

---

## Why this matters (senior perspective)

Most teams have backups. Most of those backups have never been restored. The teams find out at the worst possible moment — when their data is gone, the office is on fire, and the runbook says "restore from backup" with no further instruction.

The senior posture has four parts:

1. **A backup you haven't restored is not a backup.** It's a hopeful gesture. The first time you restore is the first time you find out whether it works. Do that on a Tuesday afternoon, not at 3 AM during an outage.
2. **RPO/RTO are measurements, not commitments.** Every customer contract has them; few correspond to reality. The cold drill is the only honest way to learn what your actual RPO and RTO are. The values you report to customers should be defensible, with drill records to prove them.
3. **Runbooks rot.** A runbook written six months ago refers to systems that have moved, accounts that have been rotated, and tools that have been deprecated. Quarterly drills are not a "best practice" — they're the discipline that keeps the runbook honest.
4. **The drill is more valuable than the procedure.** Even if your runbook is perfect, the drill teaches you. You'll discover that the IAM role you assume during recovery requires MFA from the device that just burned. You'll discover that your backup encryption key is in the same region as the dead Postgres. You'll discover that your DNS TTL is 24 hours and you can't fail over within RTO.

The fifth senior moment: **the GDPR backup-retention bind**. You delete a user's data on request. Your backups still contain it. If you restore from backup, you've resurrected the deleted data — a GDPR violation. The cure: define a backup retention window (e.g., 35 days), document it in the DPA, and accept that "right to be forgotten" is fully effective only after that window. Every multi-tenant SaaS hits this; senior engineers know the answer before legal asks.

---

## Hands-on plan

### Step 1 — Set up backup infrastructure

For local learning, you'll use `MinIO` (S3-compatible) for backup storage and `LocalStack` (or a hand-rolled key) for KMS simulation.

1. Add MinIO to docker-compose. Configure a bucket: `sms-backups`.
2. Add LocalStack KMS service or generate a static key for envelope encryption.
3. Configure Postgres `archive_mode = on`, `archive_command = ...` to push WAL segments to MinIO. Use `pgbackrest` or `wal-g` as the production-grade tools (don't roll your own).

Choose `pgbackrest` (more mature, more documented) or `wal-g` (simpler, supports more clouds) — write the ADR for whichever you pick.

### Step 2 — Schedule base backups

Daily base backup via the chosen tool:

- Run as a Kubernetes CronJob or a Docker Compose periodic container.
- Push to `s3://sms-backups/<cluster>/base/<timestamp>/`.
- Encrypt with the KMS key (envelope encryption: data key wraps the backup; KMS key wraps the data key).
- Verify the backup is readable from a different machine — not just "the upload succeeded."

Retain 35 days of base backups + WAL. Older backups are deleted (lifecycle policy on the bucket).

### Step 3 — Document the runbook

Write `docs/runbooks/dr-restore.md`. Include:

- **Trigger conditions**: when do you initiate a DR restore vs. trying to repair in place?
- **Authorization**: who must approve? (For Phase 1, you. For production, named oncall + manager.)
- **Communication**: who do you tell? Status page update template? Customer email template?
- **Pre-restore steps**: snapshot the broken state for forensics; cordon the cluster; cut traffic.
- **Restore procedure**: exact commands, with placeholders for cluster names, timestamps, regions.
- **Verification**: how do you confirm the restore succeeded? Hash comparison? Smoke tests?
- **Post-restore steps**: re-enable traffic, monitor error rates, write the post-mortem.
- **Estimated duration**: per step. Total target: under your RTO.

The runbook is a *document you've never read*. If you're reading it for the first time during a real outage, it's useless.

### Step 4 — Per-tenant logical backup (silo-tier preview)

For pool-tier tenants, the cluster backup is the only restore unit. For silo-tier tenants (Phase 3 fully), you also want per-tenant restore.

Build the per-tenant export now, even though you have no silo tenants:

```
pg_dump --table='public.*' --where='tenant_id=<uuid>' --format=custom --file=<file> tenant_data_db
```

Encrypt with KMS, push to `s3://sms-backups/<cluster>/per-tenant/<tenant_id>/<timestamp>`.

This is not a complete tenant snapshot (it misses things like Auth, audit log) — it's a learning exercise. The full silo-tier productization is a Phase 3 project. Document the gap.

### Step 5 — The cold drill (the actual milestone)

The drill is the milestone. Everything before this is preparation.

**The rules:**
1. Pick a Tuesday afternoon. Not Friday (no one wants to fix it on the weekend if it goes wrong). Not Monday (you're fresh; that's fine).
2. Capture the database's pre-drill state. Compute a hash of all tenant data: `pg_dump | sort | sha256sum` or similar. Save it.
3. Stop application traffic. Cordon the cluster (`kubectl cordon`), or scale deployments to zero.
4. **Drop the database.** No "rename and keep around" — actually `DROP DATABASE`. The drill is meaningless if you have a back-out.
5. Open the runbook. Follow it exactly. **No improvising.** If the runbook says "run command X," you run X. If X doesn't work, log the failure and find what's missing — don't go off-script.
6. Restore from latest base backup + WAL replay to a target point in time (e.g., 5 minutes before drop).
7. Verify the data: re-compute the hash. If it matches, the restore is correct. If not, dig in.
8. Resume traffic.
9. Stop the timer. Record actual RTO.
10. Compute actual RPO from the recovery point timestamp.
11. **Write the post-mortem.**

### Step 6 — The post-mortem

Document, in the same `docs/runbooks/` or a `postmortems/` folder:

- **What happened**: drill executed at <date>, target system: <local kind cluster>, target RTO: <X>, actual RTO: <Y>.
- **What went well**.
- **What went wrong**: the ~3 things that broke. Be honest. Examples from real drills:
  - "WAL archive lagged by 8 minutes; actual RPO was 8 minutes, not 5."
  - "MinIO credentials in runbook had been rotated; restore failed for 12 minutes while I found the new ones."
  - "Restore script assumed a specific Postgres version; the kind cluster had a newer version; rejected. 9 minutes lost."
- **What we're changing**: concrete fixes with owners and dates.
- **Next drill**: scheduled for <quarter+3 months>.

The post-mortem is not for performance review or blame. It is for the next person — possibly a future you — who runs this drill.

### Step 7 — Restore on a different machine

If your drill restores to the same kind cluster you ran the application on, you've validated the procedure but not the *resilience*. The next drill (or this one's stretch) restores to a *different* kind cluster — simulating "the production cluster is gone." This catches assumptions like:
- "The KMS key is regional and I'm restoring in another region."
- "The backup bucket is in the same VPC as the original cluster."
- "The Kubernetes secrets are not in the backup."

Even on your laptop, you can spin up a second kind cluster (`kind create cluster --name sms-dr`) and restore there. Different contexts; same data.

### Step 8 — Verify retention is honored

Compute: a tenant deleted yesterday should still appear in backups within the 35-day window. After 35 days, the backup containing them must be expired. Verify the bucket lifecycle policy is correct.

Document in your DPA-equivalent (or in your privacy policy notes): "Personal data deleted on user request is removed from production immediately and from backups within 35 days." This is the GDPR Art. 17 commitment with the operational reality.

### Step 9 — Crypto-shredding (silo-tier preview)

For silo tenants (Phase 3), the per-tenant KMS key wraps all that tenant's data — backups, application data, audit log. Destroying the key renders all that data unrecoverable, faster than any retention window.

Build the mechanism now even if you don't use it: a script that takes a `tenant_id`, deletes the tenant's KMS key alias (LocalStack), and confirms the tenant's encrypted data is now unreadable. The "right to be forgotten" gets a fast path for the silo tier.

This is the kind of feature that exists in the architecture's *intentions* (the original document mentions it) but rarely gets built until a regulator asks for it. Building it ahead is a senior move.

### Step 10 — Schedule the next drill

Open your calendar. Schedule the next drill for 3 months from today. Block the entire afternoon.

**This is the milestone-1.9 win condition.** A drill performed once is a tutorial. A drill scheduled quarterly is a discipline. The intent matters; the calendar entry is the artifact.

### Step 11 — Write the ADRs

At least two:
- [`adr/0018-backup-strategy.md`](../adr/) — `pgbackrest` vs `wal-g`, retention window (35 days defended against GDPR / restore needs), encryption scheme.
- [`adr/0019-dr-tier-targets.md`](../adr/) — RPO and RTO targets per tier (pool: RPO 5min/RTO 30min; silo: RPO 1min/RTO 15min), how they were measured, and the conditions under which they tighten.

---

## Definition of done

- [ ] WAL archiving configured; segments visible in MinIO. **Deferred to milestone 2.0** alongside the pgbackrest migration. Phase 1 ships pg_dump-based DR with no WAL replay; ADR-0019 documents the trade-off + the five graduation triggers that flip the decision.
- [x] Daily base backups, encrypted via envelope (DEK wrapped by static KEK simulating KMS), pushed to MinIO. *(commit `feat(infra/backup): dr-backup.sh + dr-restore.sh`; verified end-to-end with the drill)*. **Cron schedule itself is deferred** — running on demand today; CronJob/compose-cron sidecar is mechanical.
- [x] Per-tenant logical backup tooling exists. *(commit `feat(infra/backup): per-tenant logical backup tool`; SIS-aggregate scope; row-level filtering via RLS at restore time; full row-filtering-at-backup-time productization is the Phase 3 silo concern)*.
- [x] DR runbook in `docs/runbooks/dr-restore.md`. *(commit `docs(runbook): DR restore procedure`; revised post-drill in `fix(infra/backup): drill-1 fixes` to add Step 3.5 grants + Step-5 nx-reset prereq + row-count verification)*.
- [x] **Cold drill executed**. *(commit `docs(drill): cold drill #1`; sms_sis dropped + restored; RTO ~3 minutes from drop to verified-query-passes)*.
- [x] Actual RPO + RTO measured + documented. *(post-mortem `docs/postmortems/2026-05-10-cold-drill-1.md`; ADR-0020 codifies the measured numbers + per-tier targets)*.
- [x] Post-mortem written; **3 issues identified** (hash methodology, missing grants, nx daemon stale lock); all 3 fixed in `fix(infra/backup): drill-1 fixes`.
- [~] Restore tested on a *different* cluster. **Procedure documented** in runbook Section 6 (cross-cluster restore via second compose Postgres container); **physical execution deferred to drill #2** scheduled for 2026-08-10.
- [~] 35-day retention via bucket lifecycle. **Bucket has versioning ENABLED**; lifecycle policy not wired yet (MinIO supports it; the actual `mc ilm import` step is deferred to milestone 2.0 alongside the cron schedule + pgbackrest migration).
- [x] Crypto-shredding script for silo tenants. *(commit `feat(infra/backup): crypto-shred-tenant-key.sh`; --create / --shred / --status; tested lifecycle end-to-end)*.
- [~] Next drill scheduled. **2026-08-10 documented in the post-mortem's "Drill #2 — what we'll test that #1 didn't" section**. The actual calendar entry is the operator's habit, not a code artifact.
- [x] ADR-0019 (backup strategy) and ADR-0020 (DR tier targets) written. *(numbers shifted from milestone-doc 0018/0019 because milestone 1.8 took those slots; cumulative renumbering pattern in each ADR)*.

**End-to-end verified during this milestone:**

The cold drill itself:
  • Pre-drill snapshot at 14:55:35Z (24 students, 1 guardian, 2 links,
    20 outbox events, 4 processed_requests in sms_sis).
  • Fresh base backup taken at 14:55:47Z, pushed to MinIO encrypted.
  • `DROP DATABASE sms_sis` at 14:55:55Z — no back-out.
  • Restore via `dr-restore.sh` — 4 seconds of actual database work,
    sha256 verified against manifest.
  • Post-restore: row counts match exactly; RLS policies + SECURITY
    DEFINER `app.is_guardian_of` + FORCE-RLS flag all intact.
  • Smoke test (app_user with tenant context) returned the expected
    1 visible student after re-applying GRANTs (issue #2 fix).
  • Total RTO: ~3 minutes including diagnostic time on issue #2.

Drill found 3 issues — exactly what milestone 1.9's framing
anticipated. All addressable; all fixed in the same milestone.

---

## Common pitfalls

1. **"We have backups" treated as equivalent to "we have DR."** Backups are necessary; not sufficient. The restore is the work.
2. **Drilling warm.** Reading the runbook beforehand, "checking the procedure" — defeats the purpose. The cold drill catches what cold reality would catch.
3. **Drilling on the same cluster.** Restoring to the live cluster validates the procedure but not the resilience. Use a fresh target.
4. **Backup encryption key in the same blast radius as the source.** If a region goes down and your KMS goes with it, your backups are unrecoverable. Cross-region or independent key custody.
5. **No documented retention window.** A user requests deletion. Three weeks later, a restore happens. Their data resurrects. GDPR Art. 17 violated. Document the window; communicate it.
6. **Runbook in the same wiki/system that's broken.** When AWS is down, your runbook hosted on AWS is unreachable. Print it. Check it into git. Have it on a USB stick. (Yes, really.)
7. **Skipping the post-mortem.** The drill happens; you fix things in the moment; you don't write up what was learned. Three months later, the next drill repeats the same lessons.
8. **No-back-out drill.** Real drills drop the data. Drills with a back-out plan don't drill anything but the most optimistic path.
9. **Restoring data without testing the application against it.** The data restored. Did the application start? Are queries working? Do migrations need to be re-run? Smoke tests are part of the verify step.
10. **Backups under the same credentials as the source.** If the source is compromised (credentials leaked), the backups are compromised too. Backup credentials should be separate, with write-only access for the production system and read access only for restore.

---

## Stretch goals (optional rabbit holes)

- **Automate the drill.** A CI job that quarterly spins up a kind cluster, restores from latest backup, runs smoke tests, posts results to Slack/email. Continuous DR validation.
- **Per-tenant restore to a sandbox.** "Restore tenant X's data to a test cluster as of yesterday" — useful for support cases ("can you tell me what student records existed before our user accidentally bulk-deleted them?").
- **Cross-region replication.** WAL streamed to a second region's storage, base backups replicated. Phase 2 territory; preview here.
- **Chaos engineering**: introduce failures other than data loss — slow disks, network partitions, half-corrupt backups. The drills you run shape the resilience you have.
- **Read AWS's RDS PITR documentation** in detail. Even if you're not on AWS, the conceptual model is excellent.
- **Read *The Phoenix Project*** — fiction about IT operations. The DR scenes are cautionary tales worth absorbing.
- **Build a "DR readiness dashboard"** showing: time since last successful base backup, WAL archive lag, time since last drill, days remaining until next scheduled drill.

---

## Reflection questions

1. **What's the difference between RPO and RTO?** State them in one sentence each, then state your measured values from the drill.
2. **Your drill found three issues. What were they, and how would you have discovered them in production without the drill?**
3. **A user requests deletion under GDPR. Trace what happens to their data: in production immediately, in backups over 35 days, after 35 days. Where could a flaw resurrect their data?**
4. **The DR runbook says "go to MinIO and pull `<bucket>`." MinIO is down. What's the next runbook entry?** (If there isn't one, fix the runbook.)
5. **Your measured RTO was 47 minutes. The contractual RTO is 30 minutes. What changes?**
6. **Crypto-shredding: walk through the steps for destroying a silo tenant's data faster than the 35-day backup window.**
7. **You're hiring a new engineer. They ask: "When was the last time we restored from backup?" What's the right answer?**

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §7 (DR per tier).
- **PostgreSQL docs:** *Continuous Archiving and Point-in-Time Recovery* (Ch. 26).
- **`pgbackrest` documentation** — `pgbackrest.org/user-guide.html`.
- **`wal-g` documentation** — `github.com/wal-g/wal-g`.
- **AWS RDS PITR docs** — even on a different cloud, the concepts transfer.
- **Google SRE Workbook**, *Disaster Recovery Testing* chapter.
- **Gene Kim et al., *The Phoenix Project*** — fiction; teaches DR culture vicariously.
- **GDPR Art. 17 (Right to erasure)** — the regulatory underpinning of backup retention windows.

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.9 to `Done`. **Phase 1 is now complete.** Ten milestones; ten ADRs (or more); one drill; a system you understand top-to-bottom.

Before opening Phase 2, do a Phase 1 retrospective: re-read each milestone's reflection questions, your own answers, and your ADRs. Write a Phase 1 summary post in your own words — what you learned, what you'd change, what surprised you. This artifact is the most valuable thing the entire project produced. It's the proof, to yourself and to a future interview panel, that you've thought through every layer of a multi-tenant SaaS.

Phase 2 awaits: multi-region, Citus, service mesh, event sourcing, the silo tier productized, and the patterns that come into focus only after the foundations are unshakable.
