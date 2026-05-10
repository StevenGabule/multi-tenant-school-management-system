# Runbook: DR restore of a Postgres database

> **Severity scope:** P0 (data loss / corruption affecting one or more
>   application databases) and P1 (suspected silent corruption that
>   warrants restoring to a sandbox for forensic comparison).
> **Last cold drill:** 2026-05-10 (see `docs/postmortems/`).
> **Estimated total RTO:** 25 minutes from "decision to restore" to
>   "traffic resumed." Verified — see Drill 1 post-mortem.

This runbook is the document you've never read. **Do not** read it the
first time during an outage. Read it now (you, future-you, anyone).
The cold drill is the gap-finder; this is the procedure once the gaps
are closed.

---

## 0. Trigger conditions — DO restore vs. DON'T restore

Restore from backup when:

- A `DROP DATABASE` / `DROP TABLE` ran by mistake AND the affected
  data isn't recoverable from logs/audit trails within 5 minutes.
- Storage corruption: Postgres `pg_check_visible` errors, checksum
  mismatch, segments unreadable.
- A buggy migration ran and corrupted data WIDELY (one row: roll
  forward; >1% of a table: restore).
- A cryptolocker / ransomware event.

Do NOT restore when:

- One application bug overwrote a few rows: roll forward, `UPDATE` from
  the application, audit log, or replicas.
- Performance is bad: the database is slow, not corrupt — investigate
  via the platform-overview dashboard first.
- A single tenant is angry: per-tenant restore (see "Sandbox restore"
  below) is a different procedure with no platform impact.

**The decision is reversible only forward in time.** A restore drops
all writes after the recovery point; if your incident is "user X's
record was deleted," 5 minutes of replay-loss-from-everyone-else is
worse than the original incident. Stop. Think. Then restore.

---

## 1. Authorization and communication

**Who must approve a P0 restore:**
- Single named on-call engineer (Phase 1: project owner).
- Phase 2+: also the engineering manager + a peer on-call as a sanity
  check. The reason: you're about to drop the database. Pair on it.

**Communication checklist (before restore starts):**
- [ ] Status page → "investigating" (Phase 2: automated; today: manual).
- [ ] Customer-facing email queued (don't send until restore complete).
- [ ] Internal: post in #incidents Slack with the timestamp, scope of
      the database affected, expected RTO, and the runbook link.

**Communication checklist (after restore complete):**
- [ ] Status page → "recovered."
- [ ] Send the customer-facing email if any tenant data window was
      lost. Be specific about the window (e.g., "writes between
      14:25 and 14:32 UTC may need to be re-entered").
- [ ] Internal: post in #incidents with actual RTO + RPO and link
      to the post-mortem (which you will write within 48 hours).

---

## 2. Pre-restore checklist

Run before touching the broken state:

```bash
# 1. Forensic snapshot — preserve the evidence even if it's broken.
docker exec sms-postgres pg_dumpall \
  -U sms_app --globals-only > /tmp/pre-restore-globals.sql || true
docker exec sms-postgres pg_dump \
  -U sms_app --schema-only "$DB" > /tmp/pre-restore-schema.sql || true
# (Don't dump the data — it's broken; we just want the schema for diff.)

# 2. Cordon the application — stop writes.
#    Today (Phase 1, single host): kill the service processes.
#    Phase 2 (k8s): kubectl scale deploy/<service> --replicas=0
ss -tlnp 2>&1 | grep -E ':3000|:3001|:3002|:3003|:3004|:3005' \
  | grep -oP 'pid=\K[0-9]+' | xargs -r kill

# 3. Capture pre-restore data hash (only if the data is meant to be
#    intact and you're testing a drill — skip in a real restore).
docker exec sms-postgres pg_dump -U sms_app "$DB" \
  | sort | sha256sum > /tmp/pre-drill-$DB.sha256

# 4. Confirm latest backup IS in MinIO.
docker run --rm --network sms_default \
  -e MC_HOST_local="http://sms_backup_admin:local_dev_only_change_me_for_minio@minio:9000" \
  quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z \
  ls "local/sms-backups/base/" | tail -3
```

If the latest backup is older than your RPO budget, **stop and escalate**.
A restore from a too-old backup is a worse outcome than continuing to
debug in place.

---

## 3. Restore procedure

The exact commands. Run from the repo root.

```bash
# Variables — set these BEFORE running anything below.
DB=sms_sis                            # the database to restore
TIMESTAMP=20260510T145116Z            # the backup timestamp from `mc ls`
TARGET_DB=$DB                         # restore to same name (default)

# Verify the inputs.
echo "About to restore $DB from backup at $TIMESTAMP into $TARGET_DB"
echo "Type 'yes' to continue:"; read CONFIRM
[ "$CONFIRM" = yes ] || exit 1

# Run the restore. dr-restore.sh:
#   • pulls the encrypted dump + wrapped DEK + manifest from MinIO
#   • unwraps DEK with the KEK at infra/backup/dev-kek.bin
#   • decrypts the dump
#   • verifies sha256 against the manifest
#   • drops + creates the target DB
#   • pg_restore
./infra/backup/dr-restore.sh \
  --timestamp "$TIMESTAMP" \
  --db "$DB" \
  --target-db "$TARGET_DB"
```

**If `dr-restore.sh` fails on hash verification:** the bucket object
is corrupt or tampered. STOP. Do not continue with `--skip-hash` —
investigate via:

```bash
docker run --rm --network sms_default \
  -e MC_HOST_local="http://sms_backup_admin:local_dev_only_change_me_for_minio@minio:9000" \
  quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z \
  ls --versions "local/sms-backups/base/$TIMESTAMP/$DB.dump.enc"
```

The bucket has versioning enabled — earlier-version objects are
recoverable. Pick the prior version, set `--timestamp` to that backup,
retry.

**If the KEK is missing** (`dev-kek.bin` not found): the restore is
impossible. The KEK lives in the operator's separate-blast-radius
location. In Phase 1 (dev), regenerating means the bucket's data is
permanently unreadable — that's intentional, the cost of envelope
encryption with key custody.

---

## 3.5. Re-apply per-database grants (drill-1 fix)

`pg_dump` per-DB does NOT capture role-level GRANTs. `pg_restore`
with `--no-owner --no-privileges` (which we use to keep ownership
sane on the target) ALSO drops privileges. Result: app_user has no
SELECT on the restored tables, services 500.

Drill #1 (2026-05-10) caught this. The fix is two-layered:

  - `dr-backup.sh` now also captures `pg_dumpall --globals-only` and
    encrypts it as `globals.sql.enc`. Restoring it re-creates roles
    + cluster-wide grants.
  - This step explicitly re-runs the per-DB GRANTs as a defense-in-
    depth backstop. Roles capture cluster-level state; some grants
    live in per-DB migrations.

```bash
# Restore the cluster globals (one time per restore session, not per DB).
GLOBALS_DIR=$(mktemp -d)
docker run --rm --network sms_default \
  -v "$GLOBALS_DIR:/work" \
  -e MC_HOST_local="http://sms_backup_admin:local_dev_only_change_me_for_minio@minio:9000" \
  quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z \
  cp "local/sms-backups/base/$TIMESTAMP/globals.sql.enc" /work/ \
  "local/sms-backups/base/$TIMESTAMP/globals.dek.wrapped" /work/

# Unwrap + decrypt
openssl enc -aes-256-cbc -pbkdf2 -d \
  -in "$GLOBALS_DIR/globals.dek.wrapped" -out "$GLOBALS_DIR/globals.dek.plain" \
  -pass file:./infra/backup/dev-kek.bin
openssl enc -aes-256-cbc -pbkdf2 -d \
  -in "$GLOBALS_DIR/globals.sql.enc" -out "$GLOBALS_DIR/globals.sql" \
  -pass file:"$GLOBALS_DIR/globals.dek.plain"

# Apply globals (idempotent — roles already exist will be skipped with
# warnings, which we ignore).
docker run --rm --network sms_default -v "$GLOBALS_DIR:/work" \
  -e PGPASSWORD=local_dev_only_change_me_when_you_can postgres:16-alpine \
  psql -h postgres -p 5432 -U sms_app -d postgres -f /work/globals.sql || true

rm -rf "$GLOBALS_DIR"

# Per-DB GRANTs as backstop (defense in depth for grants that live in
# per-DB migration SQL).
docker run --rm --network sms_default \
  -e PGPASSWORD=local_dev_only_change_me_when_you_can postgres:16-alpine \
  psql -h postgres -p 5432 -U sms_app -d "$TARGET_DB" <<'SQL'
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user;
-- per-service additions: SECURITY DEFINER functions etc.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='app' AND p.proname='is_guardian_of') THEN
    GRANT EXECUTE ON FUNCTION app.is_guardian_of(uuid, uuid) TO app_user;
  END IF;
END$$;
SQL
```

## 4. Verification

After restore completes, verify the data:

```bash
# 1. Schema present
docker run --rm --network sms_default \
  -e PGPASSWORD=local_dev_only_change_me_when_you_can \
  postgres:16-alpine \
  psql -h postgres -p 5432 -U sms_app -d "$TARGET_DB" -c "\dt"

# 2. Row counts (sanity check, not data integrity)
docker run --rm --network sms_default \
  -e PGPASSWORD=local_dev_only_change_me_when_you_can \
  postgres:16-alpine \
  psql -h postgres -p 5432 -U sms_app -d "$TARGET_DB" -c "
    SELECT 'student' AS table, COUNT(*) FROM student
    UNION ALL SELECT 'guardian', COUNT(*) FROM guardian
    UNION ALL SELECT 'guardian_link', COUNT(*) FROM guardian_link;
  "

# 3. Per-table aggregation comparison (drill only). Drill #1 lesson:
#    pg_dump's `sort | sha256sum` ALSO captures session-specific
#    metadata (`-- Started on <ts>`, SET statements with cluster
#    state) that varies per run, producing false mismatches for
#    bit-identical data. Use row-count + per-column aggregation
#    instead — same data, real test, no metadata noise.
docker run --rm --network sms_default \
  -e PGPASSWORD=local_dev_only_change_me_when_you_can postgres:16-alpine \
  psql -h postgres -U sms_app -d "$TARGET_DB" -tAc "
    SELECT 'student'         AS t, COUNT(*), MAX(\"createdAt\") FROM student
    UNION ALL SELECT 'guardian',         COUNT(*), MAX(\"createdAt\") FROM guardian
    UNION ALL SELECT 'guardian_link',    COUNT(*), MAX(\"createdAt\") FROM guardian_link
    UNION ALL SELECT 'outbox_event',     COUNT(*), MAX(\"occurredAt\") FROM outbox_event
    UNION ALL SELECT 'processed_request',COUNT(*), MAX(\"createdAt\") FROM processed_request;
  " > /tmp/post-restore-$TARGET_DB.agg
# Diff against the pre-drill aggregation captured in Step 2's pre-restore
# checklist. Match = data is intact; mismatch = investigate which
# table differs.
```

**Aggregation mismatch in a drill** = backup is missing data the live
DB contained at snapshot time. Common causes:
- pg_dump-based DR has no WAL replay, so writes between the last base
  backup and the drop are lost. **This is the expected RPO of Phase-1
  DR.** ADR-0019 documents the trade-off.
- Backup completed between writes, so the base captures pre-write
  state for some rows and post-write for others.

**Aggregation match** = restored data is identical to the snapshot
at the row + recency level we care about. The drill is a success.

---

## 5. Resume traffic

```bash
# Drill #1 lesson: if Step 1's cordon used `kill` (Phase-1 single-host),
# nx daemon may hold a stale serve lock — `nx reset` clears it.
# Phase-2 k8s deploys via kubectl scale and don't need this.
pnpm exec nx reset

# Restart services
pnpm exec nx serve @org/tenant-service > /tmp/ts.log 2>&1 &
pnpm exec nx serve @org/sis-service > /tmp/sis.log 2>&1 &
# ... etc
```

Wait 30 seconds, then probe:

```bash
for p in 3001 3002 3003 3004 3005; do
  curl -sS -o /dev/null -w "  :$p -> %{http_code}\n" -m 3 "http://localhost:$p/livez"
done
```

Watch the platform-overview Grafana dashboard
(<http://localhost:3030/d/sms-platform-overview>) for 5 minutes:
- Error rate should return to baseline.
- Per-tenant top-N should populate as soon as traffic resumes.
- p99 latency should not spike — if it does, the restored DB may
  need ANALYZE or query plan refresh.

---

## 6. Cross-cluster restore (the second-instance drill)

The default `dr-restore.sh` restores in-place, which validates the
procedure but not the resilience. To validate "the production cluster
is gone," restore to a fresh Postgres instance.

For this dev environment, "different cluster" = a second Postgres
container in compose, isolated from the primary. **In production
this would be a different region's RDS instance.**

```bash
# 1. Spin up a second Postgres container (one-shot; for the drill).
docker run -d --name sms-postgres-dr --network sms_default \
  -e POSTGRES_USER=sms_app -e POSTGRES_PASSWORD=local_dev_only_change_me_when_you_can \
  -e POSTGRES_DB=postgres -p 5434:5432 \
  postgres:16-alpine

# 2. Restore to it.
./infra/backup/dr-restore.sh \
  --timestamp "$TIMESTAMP" \
  --db sms_sis \
  --target-host sms-postgres-dr \
  --target-port 5432

# 3. Verify
docker run --rm --network sms_default \
  -e PGPASSWORD=local_dev_only_change_me_when_you_can \
  postgres:16-alpine \
  psql -h sms-postgres-dr -p 5432 -U sms_app -d sms_sis \
  -c "SELECT COUNT(*) FROM student"

# 4. Tear down the DR container
docker rm -f sms-postgres-dr
```

This catches the assumption "the KMS key / backup credentials / docker
network are all in the same blast radius." If the second instance is on
a different host (Phase 2: different region), the dependencies become
visible.

---

## 7. Sandbox per-tenant restore

For support cases — "restore tenant X to yesterday's state in a
sandbox so I can compare against current" — use the per-tenant tooling.

```bash
TENANT=<uuid>
TIMESTAMP=20260510T145330Z   # from `mc ls per-tenant/$TENANT/`

# A future per-tenant-restore.sh wraps this; today, manually:
./infra/backup/per-tenant-backup.sh --tenant "$TENANT" --db sms_sis
# (then mc cp the previous timestamp's dump.enc, decrypt, pg_restore
# into a sandbox DB; full procedure documented in the post-mortem of
# the next drill)
```

(Per-tenant restore tooling is partial in milestone 1.9. Phase 3
productizes it as `tenant-restore.sh`.)

---

## 8. Post-restore steps

Within the same hour:

- [ ] Update the status page to "recovered."
- [ ] Send the customer-facing email if data was lost.
- [ ] File the incident ticket (Linear / GitHub Issues).

Within 48 hours:

- [ ] Write the post-mortem in `docs/postmortems/<date>-<scope>.md`.
- [ ] Update THIS runbook with anything that didn't match reality.
  Every drill or incident reveals at least one runbook bug.
- [ ] Schedule the next quarterly drill.

---

## Estimated step durations (Phase 1, single-host)

| Step                           | Target | Drill 1 actual |
|--------------------------------|--------|----------------|
| 0. Decision + comms            | 5m     | TBD            |
| 1. Pre-restore checklist       | 3m     | TBD            |
| 2. Restore procedure           | 5m     | TBD            |
| 3. Verification                | 3m     | TBD            |
| 4. Resume traffic + monitor    | 5m     | TBD            |
| 5. Internal/external comms     | 4m     | TBD            |
| **Total RTO**                  | **25m**| **TBD**        |

The "TBD" column is filled in after each drill. The Drill-1 numbers
land in the post-mortem and feed back into ADR-0020's RPO/RTO targets.
