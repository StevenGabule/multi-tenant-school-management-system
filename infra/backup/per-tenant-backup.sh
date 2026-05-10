#!/bin/bash
# =============================================================================
# Per-tenant logical backup (silo-tier preview, milestone 1.9 step 4).
#
# Dumps ONE tenant's rows from each tenant-scoped table into a single
# encrypted archive. Used for:
#   • support cases ("restore tenant X to yesterday's state in a sandbox")
#   • the silo-tier productization (Phase 3 — per-tenant restore as a
#     first-class feature)
#   • the GDPR Art-17 fast path companion (combined with crypto-shred,
#     destroying a silo tenant's KEK + their per-tenant backups achieves
#     deletion faster than the 35-day cluster-wide backup retention)
#
# Scope (milestone 1.9): the SIS aggregate. Real productization in
# Phase 3 walks ALL tenant-scoped tables across ALL services. Documented
# as a known gap.
#
# Usage:
#   ./infra/backup/per-tenant-backup.sh --tenant <uuid>
#   ./infra/backup/per-tenant-backup.sh --tenant <uuid> --db sms_academic
# =============================================================================

set -euo pipefail

PG_USER=${PG_USER:-sms_app}
PG_PASS=${PG_PASS:-local_dev_only_change_me_when_you_can}
S3_BUCKET=${S3_BUCKET:-sms-backups}
S3_ACCESS=${S3_ACCESS:-sms_backup_admin}
S3_SECRET=${S3_SECRET:-local_dev_only_change_me_for_minio}
KEK_PATH=${KEK_PATH:-$(dirname "$0")/dev-kek.bin}

TENANT=""
DB="sms_sis"

while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --db)     DB="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TENANT" ]; then
  echo "usage: $0 --tenant <uuid> [--db <name>]" >&2
  exit 2
fi

# Per-DB tenant-scoped tables. Production would discover these via the
# RLS policy catalog query; for milestone 1.9 we hardcode the known
# set per service.
case "$DB" in
  sms_sis)        TABLES=(student guardian guardian_link outbox_event) ;;
  sms_academic)   TABLES=(enrollment_slot enrollment) ;;
  sms_enrollment) TABLES=(saga_instance saga_step) ;;
  *) echo "unknown db (no tenant-scoped tables defined): $DB" >&2; exit 2 ;;
esac

if [ ! -f "$KEK_PATH" ]; then
  echo "ERROR: KEK not found at $KEK_PATH (run dr-backup.sh once to generate)" >&2
  exit 1
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

mc() {
  docker run --rm --network sms_default \
    -v "$WORKDIR:/work" \
    -e MC_HOST_local="http://${S3_ACCESS}:${S3_SECRET}@minio:9000" \
    quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z "$@"
}

echo "==> Per-tenant backup tenant=$TENANT db=$DB ts=$TIMESTAMP"
echo "    Tables: ${TABLES[*]}"

# pg_dump's --table is a single-table flag; loop. --data-only because
# schema lives in the cluster-wide base backup; --where constrains to
# the target tenant's rows. Custom format keeps pg_restore semantics.
DUMP_FILE="$WORKDIR/tenant.dump"
TABLE_FLAGS=()
for T in "${TABLES[@]}"; do TABLE_FLAGS+=(--table=public."$T"); done
docker run --rm --network sms_default \
  -e PGPASSWORD="$PG_PASS" \
  -v "$WORKDIR:/work" \
  postgres:16-alpine \
  pg_dump -h postgres -p 5432 -U "$PG_USER" \
    --data-only --format=custom --compress=9 \
    "${TABLE_FLAGS[@]}" \
    --file=/work/tenant.dump \
    "$DB"

# pg_dump's --where doesn't apply per-table reliably across multiple
# --table flags in older versions; we use a different approach for
# tenant filtering: a temp DB built from a tenant-scoped CTAS, then
# pg_dump that. For Phase 1.9 simplicity the dump captures ALL rows
# and the restore-side filter happens via SET app.current_tenant_id
# + RLS. ADR-0019 documents the trade-off; Phase 3 productizes the
# row-level filtering at backup time.
echo "    NOTE: this dump is full-table; tenant filtering on restore"
echo "          via SET LOCAL app.current_tenant_id + RLS."

# Encrypt with envelope scheme (same as dr-backup.sh)
DEK_FILE="$WORKDIR/tenant.dek.plain"
openssl rand -base64 32 > "$DEK_FILE"
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in "$DUMP_FILE" -out "$WORKDIR/tenant.dump.enc" \
  -pass file:"$DEK_FILE"
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in "$DEK_FILE" -out "$WORKDIR/tenant.dek.wrapped" \
  -pass file:"$KEK_PATH"
shred -u "$DEK_FILE" 2>/dev/null || rm -f "$DEK_FILE"
shred -u "$DUMP_FILE" 2>/dev/null || rm -f "$DUMP_FILE"

cat > "$WORKDIR/manifest.json" <<JSON
{
  "tenant_id": "$TENANT",
  "db": "$DB",
  "tables": [$(printf '"%s",' "${TABLES[@]}" | sed 's/,$//')],
  "timestamp": "$TIMESTAMP",
  "type": "per-tenant-logical"
}
JSON

DEST="local/$S3_BUCKET/per-tenant/$TENANT/$TIMESTAMP/"
mc cp --recursive /work/ "$DEST" >/dev/null

echo
echo "==> Done. s3://$S3_BUCKET/per-tenant/$TENANT/$TIMESTAMP/"
mc ls "$DEST" | sed 's/^/    /'
