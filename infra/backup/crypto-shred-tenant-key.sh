#!/bin/bash
# =============================================================================
# Crypto-shredding for silo-tier tenants (milestone 1.9 step 8 — preview).
#
# THE PATTERN: each silo tenant's data is encrypted at rest under a
# per-tenant KEK. Destroying that KEK renders ALL the tenant's data —
# in production, in backups, anywhere — instantly unreadable. This is
# the GDPR Art-17 fast path: faster than the 35-day backup retention,
# cryptographically irreversible.
#
# Phase 1.9 stops at the pattern + tooling, NOT at production
# enforcement. The current pool-tier tenants don't have per-tenant KEKs;
# they share the cluster KEK (infra/backup/dev-kek.bin). This script
# demonstrates how a silo tenant's KEK would be created, used, and
# destroyed — when the silo tier productizes (Phase 3), the per-tenant
# data path inherits this scheme.
#
# Usage:
#   ./infra/backup/crypto-shred-tenant-key.sh --create  --tenant <uuid>
#   ./infra/backup/crypto-shred-tenant-key.sh --shred   --tenant <uuid>
#   ./infra/backup/crypto-shred-tenant-key.sh --status  --tenant <uuid>
#
# Local KEK store: infra/backup/tenant-keks/<tenant-uuid>.bin (gitignored).
# Production: a per-tenant KMS key alias, with IAM policy that prevents
# anyone from RECOVERING after deletion (KMS scheduled-deletion has a
# minimum window; for true crypto-shred you wait that out).
# =============================================================================

set -euo pipefail

TENANT_KEK_DIR=$(dirname "$0")/tenant-keks
mkdir -p "$TENANT_KEK_DIR"

ACTION=""
TENANT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --create) ACTION=create; shift ;;
    --shred)  ACTION=shred; shift ;;
    --status) ACTION=status; shift ;;
    --tenant) TENANT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ACTION" ] || [ -z "$TENANT" ]; then
  echo "usage: $0 [--create|--shred|--status] --tenant <uuid>" >&2
  exit 2
fi

KEK_FILE="$TENANT_KEK_DIR/$TENANT.bin"

case "$ACTION" in
  create)
    if [ -f "$KEK_FILE" ]; then
      echo "tenant $TENANT already has a KEK at $KEK_FILE" >&2
      exit 1
    fi
    openssl rand 32 > "$KEK_FILE"
    chmod 600 "$KEK_FILE"
    echo "created KEK for tenant $TENANT (32 bytes random)"
    echo "  → $KEK_FILE"
    ;;

  shred)
    if [ ! -f "$KEK_FILE" ]; then
      echo "no KEK found for tenant $TENANT — nothing to shred" >&2
      echo "  expected at $KEK_FILE" >&2
      exit 1
    fi
    # `shred -u`: overwrite with random data 3 times then unlink.
    # `-z`: final pass of zeros so even forensic recovery sees nothing
    # of the previous content. Belt and suspenders.
    shred -uz -n 3 "$KEK_FILE"
    echo "SHREDDED tenant $TENANT KEK at $KEK_FILE"
    echo
    echo "  Effect:"
    echo "    • Any future backup-decrypt attempt for this tenant fails."
    echo "    • All historical encrypted artifacts (bucket, snapshots,"
    echo "      cross-region replicas) become unreadable cryptographically."
    echo "    • Right-to-be-forgotten satisfied without waiting for the"
    echo "      35-day backup retention window."
    echo
    echo "  This action is IRREVERSIBLE."
    echo "  Production: also delete the KMS alias + schedule key deletion"
    echo "  with the longest available window to prevent restore-from-undo."
    ;;

  status)
    if [ -f "$KEK_FILE" ]; then
      SIZE=$(stat -c %s "$KEK_FILE")
      MTIME=$(stat -c %y "$KEK_FILE")
      echo "tenant $TENANT KEK: PRESENT"
      echo "  size:    $SIZE bytes"
      echo "  mtime:   $MTIME"
      echo "  path:    $KEK_FILE"
    else
      echo "tenant $TENANT KEK: ABSENT (never created OR shredded)"
      echo "  Encrypted artifacts for this tenant cannot be decrypted."
    fi
    ;;
esac
