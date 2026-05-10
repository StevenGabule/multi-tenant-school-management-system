# ADR-0019: Backup strategy — pg_dump for Phase 1, pgbackrest at scale

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Milestone 1.9 stands up disaster recovery. The first decision: **which
backup tool, and at what level — physical or logical?**

Three plausible options for self-hosted Postgres in 2026:

1. **`pg_dump` / `pg_dumpall`** — logical backup. SQL or custom-format
   per-DB; portable across major versions; no WAL replay. Standard
   Postgres tooling, no dependencies.
2. **`pgbackrest`** — physical backup. Full + incremental + diff +
   WAL archiving; PITR with sub-second granularity; the
   industry-standard self-hosted Postgres backup tool. Requires
   significant Postgres-side configuration (stanza, archive_command,
   pg_hba changes).
3. **`wal-g`** — physical backup, lighter than pgbackrest. Good cloud
   integrations (S3, GCS, Azure Blob). Less mature than pgbackrest;
   smaller community.

The choice has downstream consequences: encryption, retention,
restore performance, and whether PITR is achievable at all.

## Decision

**Phase 1 uses `pg_dump --format=custom` per-database, encrypted
client-side via envelope encryption, pushed to MinIO. Phase 2
(production-readiness milestone, milestone 2.0) replaces this with
`pgbackrest` for full PITR + WAL archiving. The graduation triggers
are explicit (see "Graduation triggers" below).**

### Specific rules — Phase 1

1. **`pg_dump --format=custom`** per database, daily. Custom format is
   pg_restore-compatible and compressed (`--compress=9`). Trade-off
   vs SQL format: harder to grep, but pg_restore offers selective
   restore (e.g., one table) which the SQL form doesn't.

2. **`pg_dumpall --globals-only`** captured alongside, encrypted
   separately. Drill #1 found that without this, restored DBs have
   tables but no role grants. Per-DB dump doesn't capture
   cluster-wide role state.

3. **Envelope encryption.** A per-backup data-encryption-key (DEK) is
   randomly generated, used to AES-256-CBC the dump, and the DEK
   itself is wrapped by the static dev KEK at
   `infra/backup/dev-kek.bin`. To restore you need both the bucket
   AND the KEK. The pattern is identical to AWS S3-SSE-KMS or GCS
   CMEK — production swaps the file-based KEK for a KMS-managed one.

4. **MinIO with versioning enabled.** The bucket retains all versions
   of an object — a corrupt-WAL push doesn't wipe the last good
   copy. For Phase 2 production this becomes S3 (or GCS / Azure
   Blob) with the same versioning + lifecycle.

5. **35-day retention** (lifecycle policy). Defended in two
   directions:
   - **Forward** (recovery): catches "we noticed the corruption a
     month later" scenarios.
   - **Backward** (GDPR Art-17): a tenant's deletion request is
     *immediately effective* in production but takes up to 35 days
     to propagate through backups. Document this in the DPA. Phase 1
     dev environment doesn't enforce the lifecycle (no production
     SLA); Phase 2 wires the bucket lifecycle policy + tests it.

6. **Per-tenant logical backup tooling exists** even though the
   pool tier doesn't use it. `per-tenant-backup.sh` dumps a
   tenant's tables for sandbox restore + the silo-tier productization
   path. Documented gap: row-level filtering at backup time is not
   yet implemented (the pattern + tooling are; the row filter
   graduates with Phase 3 silo productization).

7. **Crypto-shred script** for silo tenants. `crypto-shred-tenant-key.sh`
   destroys a per-tenant KEK; encrypted-at-rest tenant data becomes
   permanently unreadable. The GDPR Art-17 fast path. Phase 1 has no
   silo tenants; the script exists so Phase 3 productization is wiring,
   not invention.

### Graduation triggers — when we move to pgbackrest

We commit to evaluating the migration when ANY of these become true:

  1. **A real RPO under 1 hour.** pg_dump-based DR has no WAL replay;
     RPO is "hours since last nightly backup." When a customer
     contract requires a tighter RPO, pgbackrest's continuous WAL
     archiving is the answer.

  2. **Production data volume exceeds ~50GB per database.** pg_dump
     at this scale takes hours; pgbackrest's incremental + parallel
     transfer cuts that an order of magnitude.

  3. **Customer requirement for PITR** (e.g., "restore to 14:32 UTC
     last Tuesday"). Logical backups don't support this; physical +
     WAL replay does.

  4. **Cross-region replication for DR.** WAL streaming to a second
     region's storage is a pgbackrest first-class feature. Hand-rolling
     this on top of pg_dump is reinventing pgbackrest poorly.

  5. **Multi-cluster fleet.** Once we operate >3 Postgres clusters,
     the per-cluster `pg_dump` shell scripts become an anti-pattern.
     Centralized `pgbackrest` config + a shared S3 bucket scales
     cleanly.

If NONE of the triggers apply by milestone 2.0 review, we stay on
pg_dump. The migration is non-trivial (stanza setup,
archive_command, pg_hba changes, restore procedure rewrite); it
must pay back.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **pg_dump (Phase 1, chosen)** | Zero infrastructure beyond Postgres + S3-compatible storage; portable across PG major versions; SCRIPT-able in a weekend; runs in any container with `postgres-client` | No WAL replay → no PITR → RPO is "hours"; logical → restore time is linear with data volume + N×slower than physical; no built-in incremental | n/a — fits Phase 1's milestone-1.9 LEARNING goal (the drill itself) |
| **pgbackrest (Phase 2 target)** | Industry-standard self-hosted; full + incremental + diff + WAL; PITR with sub-second granularity; encryption + remote storage built-in; multi-cluster + multi-region tested | Heavyweight setup (stanza, repository config, postgres-side archive_command, pg_hba); learning curve | Premature for Phase 1's drill purpose — adds days of setup time without changing the drill's lessons |
| **wal-g** | Lighter than pgbackrest; native cloud integrations | Less mature; smaller community; if we're going to move from pg_dump, the standard target is pgbackrest | Marginal benefit over pgbackrest; not the industry default |
| **Postgres native pg_basebackup + WAL archive** | No third-party tools; built into Postgres | Hand-rolled retention + restore tooling; no incremental support without separate scripts; pgbackrest exists precisely to wrap this | We'd be reinventing pgbackrest |
| **Managed Postgres backups (RDS, Cloud SQL)** | Zero ops | Vendor lock-in for the recovery story; the drill becomes "click the restore button" — no learning value | Misses the milestone's point |

## Consequences

**Positive:**

- The drill is achievable in one milestone. pg_dump's setup is one
  shell script; pgbackrest's setup is its own milestone. Phase-1
  scope is preserved.
- The encryption scheme is real. Envelope encryption with a separate
  KEK matches what production-grade KMS-backed storage would do —
  the swap to KMS is a one-line change in the script.
- The drill #1 lessons (globals capture, runbook hardening) apply
  identically to a future pgbackrest migration. The lesson taxonomy
  isn't tool-specific.
- The graduation triggers are concrete. We don't move to pgbackrest
  "when it feels right" — we move when one of five named conditions
  fires.

**Negative / costs:**

- RPO is BAD: "hours since the last backup" with no WAL replay. This
  is fine for a learning project; in production, a financial or
  high-stakes domain wouldn't ship with this.
- Restore RTO is linear with data volume. Drill #1 was 4 seconds for
  ~24 students; production at 10 GB would be ~10 minutes; at 100 GB
  would breach the 30-minute RTO target ADR-0020 sets.
- pg_dump locks (briefly) on schema changes — fine at backup-window
  cadence, would conflict with high-frequency DDL deploys.
- The per-tenant backup tooling is partial — full-table dump, restore-
  side tenant filter via RLS. The shape works; the size is unbounded.

**Risks:**

- **An engineer assumes WAL replay works.** Drill #1's RPO of 8
  seconds was a drill artifact — the gap between backup and drop, not
  between drop and "last write." Real production RPO under this
  scheme is whatever the cron schedule is. Mitigation: ADR-0020 names
  this as the Phase-1 RPO; the runbook's verification step
  acknowledges "writes between backup and drop are lost."
- **The KEK lives in the same blast radius as the source.** If the
  host running Postgres also holds `dev-kek.bin`, a compromise of
  the host = compromise of all backups. Mitigation: production moves
  the KEK to a separate KMS in a different region/account. Phase 1
  documents this; Phase 2 wires it.
- **`pg_dumpall --no-role-passwords` strips passwords from the
  globals dump.** Restoring globals re-creates roles WITHOUT
  passwords; operator must re-set them post-restore. Documented in
  the runbook.
- **A tenant's deletion request hits the 35-day window.** Backups
  taken before deletion still contain the data. A compliance audit
  may flag this. Mitigation: the DPA documents the 35-day window;
  for silo tenants, crypto-shred is the fast path.

**Follow-up work this enables / forces:**

- Drill #2 (Q+3 months from drill #1): test the new globals-restore
  path + the runbook's hardened verification + cross-cluster restore.
- Milestone 2.0: pgbackrest migration if any graduation trigger fires.
  Otherwise pgbackrest is parked.
- Phase 3: silo-tier productization moves the per-tenant backup +
  crypto-shred from preview to production-grade. The pattern + tooling
  carry forward; row-level filtering at backup time gets built.
- Phase 2 ESLint rule (workspace-wide): any code that calls
  `pg_dump`/`pg_restore` from outside `infra/backup/` is rejected.
  The DR tooling is the single entry point.

## References

- PostgreSQL docs, *Continuous Archiving and Point-in-Time Recovery*
  (Ch. 26): <https://www.postgresql.org/docs/16/continuous-archiving.html>
- pgbackrest user guide: <https://pgbackrest.org/user-guide.html>
- AWS RDS PITR documentation — useful for the conceptual model even
  on different infrastructure.
- GDPR Art. 17 (Right to erasure) — the regulatory ground for the
  35-day window.
- Internal:
  - `infra/backup/dr-backup.sh` / `dr-restore.sh` — the implementation
  - `infra/backup/per-tenant-backup.sh` — silo-tier preview tooling
  - `infra/backup/crypto-shred-tenant-key.sh` — Art-17 fast path
  - `docs/runbooks/dr-restore.md` — the procedure
  - `docs/postmortems/2026-05-10-cold-drill-1.md` — the drill that
    produced the lessons this ADR codifies
- Phase 1.9 milestone: [`../phase-1/09-dr-drill.md`](../phase-1/09-dr-drill.md)
- Related: [ADR-0020](0020-dr-tier-targets.md) (the RPO/RTO targets
  this strategy serves)
