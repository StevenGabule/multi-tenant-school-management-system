-- =============================================================================
-- Migration: create the non-owner app_user role
--
-- Application traffic must NOT run as a superuser or BYPASSRLS role —
-- those bypass RLS even when FORCE ROW LEVEL SECURITY is set on the
-- table (this is the most common production multi-tenant breach pattern).
--
-- The default POSTGRES_USER (sms_app) created by the postgres image is
-- both superuser AND has BYPASSRLS. That's fine for migrations (DDL needs
-- privilege) but unacceptable for runtime. We split:
--
--   sms_app   → owns tables, runs migrations         (DATABASE_MIGRATION_URL)
--   app_user  → SELECT/INSERT/UPDATE/DELETE only,    (DATABASE_URL)
--               RLS strictly enforced
--
-- The role is idempotent (safe to re-run). The password is a local-dev
-- placeholder — production deployments inject via secret manager.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_local_dev_pwd';
  ELSE
    -- Keep password in sync if the role was created with a different one
    ALTER ROLE app_user WITH LOGIN PASSWORD 'app_user_local_dev_pwd';
  END IF;
END$$;

-- Schema usage (without this, app_user can't reach the public schema)
GRANT USAGE ON SCHEMA public TO app_user;

-- Existing tables: data ops only, no DDL
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Future tables: same defaults whenever sms_app creates a new one
ALTER DEFAULT PRIVILEGES FOR ROLE sms_app IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE sms_app IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app_user;

-- Belt-and-suspenders: fail the migration if app_user ever ends up with
-- privileges that would defeat RLS. Catches both human ALTER ROLE drift
-- and accidental superuser grants.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'app_user' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'app_user must NOT be superuser or BYPASSRLS — RLS would not enforce isolation';
  END IF;
END$$;
