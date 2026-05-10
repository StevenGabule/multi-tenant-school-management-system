#!/bin/bash
# =============================================================================
# Base backup tool for milestone 1.9.
#
# Per-database `pg_dump --format=custom` → openssl envelope encryption →
# upload to MinIO at s3://sms-backups/base/<timestamp>/<db>.dump.enc
# Plus a manifest describing what was captured.
#
# Why pg_dump (not pgbackrest): pgbackrest is the production-grade tool
# but its setup is non-trivial (stanza definitions, postgres-side config,
# pg_hba changes). For Phase 1.9 the LEARNING is the drill itself —
# pg_dump suffices to demonstrate backup → restore with verification.
# Production-grade pgbackrest WAL+PITR is deferred to milestone 2.0
# (production-readiness). ADR-0019 documents the trade-off.
#
# Encryption: envelope. A per-backup data-encryption-key (DEK) is
# generated, used to AES-256-CBC the dump, and the DEK itself is wrapped
# with the static KEK in /var/www/multi-tenant-school-management-system/infra/backup/dev-kek.bin
# (the KMS stand-in). To restore you need both the bucket AND the KEK —
# losing either alone keeps the data confidential.
#
# Usage:
#   ./infra/backup/dr-backup.sh                  # backup all DBs
#   ./infra/backup/dr-backup.sh --dbs sms_sis    # one DB
# =============================================================================

set -euo pipefail

PG_HOST=${PG_HOST:-localhost}
PG_PORT=${PG_PORT:-5433}
PG_USER=${PG_USER:-sms_app}
PG_PASS=${PG_PASS:-local_dev_only_change_me_when_you_can}
S3_ENDPOINT=${S3_ENDPOINT:-http://localhost:9100}
S3_BUCKET=${S3_BUCKET:-sms-backups}
S3_ACCESS=${S3_ACCESS:-sms_backup_admin}
S3_SECRET=${S3_SECRET:-local_dev_only_change_me_for_minio}
KEK_PATH=${KEK_PATH:-$(dirname "$0")/dev-kek.bin}

ALL_DBS=(sms_dev sms_control sms_sis sms_academic sms_enrollment)
DBS_TO_BACKUP=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dbs) IFS=',' read -ra DBS_TO_BACKUP <<< "$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ ${#DBS_TO_BACKUP[@]} -eq 0 ]; then
  DBS_TO_BACKUP=("${ALL_DBS[@]}")
fi

# Bootstrap a KEK if one doesn't exist. Production: this would be a
# KMS-managed key referenced by alias, NEVER on disk. Dev: a 32-byte
# random file is fine.
if [ ! -f "$KEK_PATH" ]; then
  echo "==> Generating dev KEK at $KEK_PATH (will be gitignored)"
  openssl rand 32 > "$KEK_PATH"
  chmod 600 "$KEK_PATH"
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# AWS-CLI replacement: use mc inside the minio container. Avoids needing
# python+boto3 / aws-cli on the host.
mc() {
  docker run --rm --network sms_default \
    -v "$WORKDIR:/work" \
    -e MC_HOST_local="http://${S3_ACCESS}:${S3_SECRET}@minio:9000" \
    quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z "$@"
}

echo "==> Base backup run $TIMESTAMP"
echo "    DBs: ${DBS_TO_BACKUP[*]}"
echo "    Target: s3://$S3_BUCKET/base/$TIMESTAMP/"

MANIFEST="$WORKDIR/manifest.json"
echo "{\"timestamp\":\"$TIMESTAMP\",\"dbs\":[" > "$MANIFEST"
SEP=""

for DB in "${DBS_TO_BACKUP[@]}"; do
  echo "    -> $DB"
  DUMP_FILE="$WORKDIR/$DB.dump"
  ENC_FILE="$WORKDIR/$DB.dump.enc"
  WRAPPED_DEK_FILE="$WORKDIR/$DB.dek.wrapped"
  HASH_FILE="$WORKDIR/$DB.sha256"

  # Take the dump (custom format — pg_restore-compatible, compressed).
  # Run inside a postgres:16-alpine container so we always use a client
  # that matches the server version. The host-installed pg_dump may be
  # an older major version that refuses to dump a newer server.
  docker run --rm \
    --network sms_default \
    -e PGPASSWORD="$PG_PASS" \
    -v "$WORKDIR:/work" \
    postgres:16-alpine \
    pg_dump \
      -h postgres -p 5432 -U "$PG_USER" \
      --format=custom --compress=9 \
      --file="/work/$DB.dump" \
      "$DB"

  # Hash the plaintext for restore-time verification.
  sha256sum "$DUMP_FILE" | awk '{print $1}' > "$HASH_FILE"

  # Generate a per-backup DEK, encrypt the dump with it, wrap the DEK
  # itself with the KEK. The DEK lives only on disk inside this script's
  # tempdir, deleted on exit.
  DEK_FILE="$WORKDIR/$DB.dek.plain"
  openssl rand -base64 32 > "$DEK_FILE"
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in "$DUMP_FILE" -out "$ENC_FILE" \
    -pass file:"$DEK_FILE"
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in "$DEK_FILE" -out "$WRAPPED_DEK_FILE" \
    -pass file:"$KEK_PATH"
  shred -u "$DEK_FILE" 2>/dev/null || rm -f "$DEK_FILE"

  SIZE=$(stat -c %s "$ENC_FILE")
  HASH=$(cat "$HASH_FILE")
  echo "${SEP}{\"db\":\"$DB\",\"size\":$SIZE,\"sha256\":\"$HASH\"}" >> "$MANIFEST"
  SEP=","
done

echo "]}" >> "$MANIFEST"

# Remove plaintext dumps + per-DB plaintext hashes from the workdir
# BEFORE the upload — only the encrypted artifacts and the manifest
# (which carries the hashes) should reach the bucket.
for DB in "${DBS_TO_BACKUP[@]}"; do
  shred -u "$WORKDIR/$DB.dump" 2>/dev/null || rm -f "$WORKDIR/$DB.dump"
  rm -f "$WORKDIR/$DB.sha256"
done

# Push remaining artifacts (encrypted dumps + wrapped DEKs + manifest).
mc cp --recursive /work/ "local/$S3_BUCKET/base/$TIMESTAMP/" >/dev/null

echo
echo "==> Done. Listing s3://$S3_BUCKET/base/$TIMESTAMP/"
mc ls "local/$S3_BUCKET/base/$TIMESTAMP/" | sed 's/^/    /'
echo
echo "Restore: ./infra/backup/dr-restore.sh --timestamp $TIMESTAMP --db <name>"
