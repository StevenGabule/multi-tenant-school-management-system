#!/bin/sh
# Postgres docker-entrypoint-initdb.d hook.
# Runs ONCE per fresh Postgres data directory (i.e., when /var/lib/postgresql/data
# is empty on first container start). For existing data dirs, this script is
# skipped — operators must create databases manually:
#   docker exec sms-postgres psql -U sms_app -d postgres -c 'CREATE DATABASE sms_X;'
#
# Creates the per-service databases. The default sms_dev (gateway) is
# created automatically by Postgres from POSTGRES_DB.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE DATABASE sms_control OWNER "$POSTGRES_USER";
  CREATE DATABASE sms_sis OWNER "$POSTGRES_USER";
  CREATE DATABASE sms_academic OWNER "$POSTGRES_USER";
EOSQL

echo "Created sms_control / sms_sis / sms_academic databases"
