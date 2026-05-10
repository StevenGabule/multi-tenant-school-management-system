#!/bin/sh
# Postgres docker-entrypoint-initdb.d hook.
# Runs ONCE per fresh Postgres data directory (i.e., when /var/lib/postgresql/data
# is empty on first container start). For existing data dirs, this script is
# skipped — operators must create the database manually if upgrading in place.
#
# Creates the control-plane database used by tenant-service. The data plane
# (sms_dev) is created automatically by Postgres from POSTGRES_DB.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE DATABASE sms_control OWNER "$POSTGRES_USER";
EOSQL

echo "Created sms_control database (control plane for tenant-service)"
