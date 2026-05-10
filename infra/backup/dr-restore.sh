#!/bin/bash
# =============================================================================
# Restore tool for milestone 1.9.
#
# Pulls an encrypted dump from MinIO, unwraps the DEK with the KEK,
# decrypts the dump, verifies the sha256 hash from the manifest, and
# pg_restores into the target database.
#
# Usage:
#   ./infra/backup/dr-restore.sh --timestamp 20260510T130000Z --db sms_sis
#   ./infra/backup/dr-restore.sh --timestamp <ts> --db <db> --target-db <new>   # to alt name
#   ./infra/backup/dr-restore.sh --timestamp <ts> --db <db> --target-host other-pg --target-port 5433
#
# Defaults: restore to the same Postgres at PG_HOST:PG_PORT, same DB name.
# Cross-cluster restore: pass --target-host pointing at a different
# Postgres instance. The drill rules require this for full validation —
# see ADR-0020.
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

TIMESTAMP=""
DB=""
TARGET_DB=""
TARGET_HOST=""
TARGET_PORT=""
SKIP_HASH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --timestamp)   TIMESTAMP="$2"; shift 2 ;;
    --db)          DB="$2"; shift 2 ;;
    --target-db)   TARGET_DB="$2"; shift 2 ;;
    --target-host) TARGET_HOST="$2"; shift 2 ;;
    --target-port) TARGET_PORT="$2"; shift 2 ;;
    --skip-hash)   SKIP_HASH=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TIMESTAMP" ] || [ -z "$DB" ]; then
  echo "usage: $0 --timestamp <ts> --db <db> [--target-db <name>] [--target-host <h>] [--target-port <p>] [--skip-hash]" >&2
  exit 2
fi

TARGET_DB=${TARGET_DB:-$DB}
TARGET_HOST=${TARGET_HOST:-$PG_HOST}
TARGET_PORT=${TARGET_PORT:-$PG_PORT}

if [ ! -f "$KEK_PATH" ]; then
  echo "ERROR: KEK not found at $KEK_PATH" >&2
  echo "       (created on first dr-backup.sh run; if missing, restore is impossible)" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

mc() {
  docker run --rm --network sms_default \
    -v "$WORKDIR:/work" \
    -e MC_HOST_local="http://${S3_ACCESS}:${S3_SECRET}@minio:9000" \
    quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z "$@"
}

echo "==> Pull s3://$S3_BUCKET/base/$TIMESTAMP/{$DB.dump.enc, $DB.dek.wrapped, manifest.json}"
mc cp "local/$S3_BUCKET/base/$TIMESTAMP/$DB.dump.enc" /work/ >/dev/null
mc cp "local/$S3_BUCKET/base/$TIMESTAMP/$DB.dek.wrapped" /work/ >/dev/null
mc cp "local/$S3_BUCKET/base/$TIMESTAMP/manifest.json" /work/ >/dev/null

echo "==> Unwrap DEK + decrypt dump"
# Unwrap the DEK with the KEK.
openssl enc -aes-256-cbc -pbkdf2 -d \
  -in "$WORKDIR/$DB.dek.wrapped" \
  -out "$WORKDIR/$DB.dek.plain" \
  -pass file:"$KEK_PATH"
# Decrypt the dump with the unwrapped DEK.
openssl enc -aes-256-cbc -pbkdf2 -d \
  -in "$WORKDIR/$DB.dump.enc" \
  -out "$WORKDIR/$DB.dump" \
  -pass file:"$WORKDIR/$DB.dek.plain"
shred -u "$WORKDIR/$DB.dek.plain" 2>/dev/null || rm -f "$WORKDIR/$DB.dek.plain"

if [ "$SKIP_HASH" -eq 0 ]; then
  ACTUAL_HASH=$(sha256sum "$WORKDIR/$DB.dump" | awk '{print $1}')
  EXPECTED_HASH=$(python3 -c "
import json, sys
with open('$WORKDIR/manifest.json') as f:
    m = json.load(f)
for d in m['dbs']:
    if d['db'] == '$DB':
        print(d['sha256'])
        sys.exit(0)
sys.exit('db $DB not in manifest')")
  if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
    echo "ERROR: sha256 mismatch — backup is corrupt or tampered" >&2
    echo "  expected: $EXPECTED_HASH" >&2
    echo "  actual:   $ACTUAL_HASH" >&2
    exit 1
  fi
  echo "    sha256 verified: $ACTUAL_HASH"
fi

# When the user passed `--target-host` we honor it as-is (cross-cluster
# restore). Otherwise we default to the docker-network hostname so the
# pg_dump/pg_restore container can reach the DB without going through
# the host's port mapping.
EFFECTIVE_HOST="$TARGET_HOST"
EFFECTIVE_PORT="$TARGET_PORT"
if [ "$TARGET_HOST" = "$PG_HOST" ] && [ "$TARGET_PORT" = "$PG_PORT" ]; then
  EFFECTIVE_HOST=postgres
  EFFECTIVE_PORT=5432
fi

echo "==> Drop+create target $TARGET_DB on $EFFECTIVE_HOST:$EFFECTIVE_PORT"
docker run --rm --network sms_default \
  -e PGPASSWORD="$PG_PASS" \
  postgres:16-alpine \
  psql -h "$EFFECTIVE_HOST" -p "$EFFECTIVE_PORT" -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";" \
    -c "CREATE DATABASE \"$TARGET_DB\" OWNER \"$PG_USER\";"

echo "==> pg_restore into $TARGET_DB"
docker run --rm --network sms_default \
  -e PGPASSWORD="$PG_PASS" \
  -v "$WORKDIR:/work" \
  postgres:16-alpine \
  pg_restore \
    -h "$EFFECTIVE_HOST" -p "$EFFECTIVE_PORT" -U "$PG_USER" \
    --dbname="$TARGET_DB" \
    --no-owner --no-privileges \
    "/work/$DB.dump"

echo
echo "==> Restore complete. Verify:"
echo "    psql -h $TARGET_HOST -p $TARGET_PORT -U $PG_USER -d $TARGET_DB -c '\\dt'"
