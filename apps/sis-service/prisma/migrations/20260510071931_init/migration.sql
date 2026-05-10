-- =============================================================================
-- Migration: initial sis-service schema (Student, Guardian, GuardianLink)
--   + RLS policies on all three (tenant isolation)
--   + app_user grants on this database
--
-- Idempotent: re-running on a database that already has the role grants
-- is a no-op (the IF NOT EXISTS / GRANT-twice pattern).
--
-- The control-plane Tenant table lives in sms_control (tenant-service).
-- tenantId here is a "logical reference" — no FK across databases. The
-- @org/tenant-registry client validates ids before any operation reaches
-- this DB.
--
-- We deliberately omit the active_only RESTRICTIVE policy that we tried
-- in milestone 1.1: under Postgres semantics it blocks UPDATE-based
-- soft-delete (the new row would be invisible to the author). The
-- repository instead filters `WHERE deletedAt IS NULL` in app code.
-- See ADR-0008 for the decision.
-- =============================================================================

-- ----- TABLES -----

CREATE TABLE "student" (
    "id"          UUID NOT NULL,
    "tenantId"    UUID NOT NULL,
    "externalId"  TEXT,
    "firstName"   TEXT NOT NULL,
    "middleName"  TEXT,
    "lastName"    TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "email"       TEXT,
    "phone"       TEXT,
    "gender"      TEXT,
    "enrolledAt"  TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "deletedAt"   TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "student_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "guardian" (
    "id"           UUID NOT NULL,
    "tenantId"     UUID NOT NULL,
    "firstName"    TEXT NOT NULL,
    "lastName"     TEXT NOT NULL,
    "email"        TEXT,
    "phone"        TEXT,
    "relationship" TEXT NOT NULL,
    "deletedAt"    TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "guardian_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "guardian_link" (
    "studentId"  UUID NOT NULL,
    "guardianId" UUID NOT NULL,
    "tenantId"   UUID NOT NULL,
    "isPrimary"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guardian_link_pkey" PRIMARY KEY ("studentId","guardianId")
);

-- ----- INDEXES -----

CREATE INDEX "student_tenantId_lastName_firstName_idx"
  ON "student"("tenantId", "lastName", "firstName");
CREATE INDEX "student_tenantId_deletedAt_idx"
  ON "student"("tenantId", "deletedAt");
CREATE UNIQUE INDEX "student_tenantId_externalId_key"
  ON "student"("tenantId", "externalId");
CREATE INDEX "guardian_tenantId_idx" ON "guardian"("tenantId");
CREATE INDEX "guardian_link_tenantId_idx" ON "guardian_link"("tenantId");

ALTER TABLE "guardian_link"
  ADD CONSTRAINT "guardian_link_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "student"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guardian_link"
  ADD CONSTRAINT "guardian_link_guardianId_fkey"
  FOREIGN KEY ("guardianId") REFERENCES "guardian"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- app_user role + grants
--
-- The role is created by sms_dev's migration (app_user_role) but role
-- privileges are PER-DATABASE. This DB needs its own grants.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_local_dev_pwd';
  END IF;
END$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user;

ALTER DEFAULT PRIVILEGES FOR ROLE sms_app IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE sms_app IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app_user;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'app_user' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'app_user must NOT be superuser or BYPASSRLS — RLS would not enforce isolation';
  END IF;
END$$;

-- =============================================================================
-- Row-Level Security on student, guardian, guardian_link
--
-- ENABLE turns RLS on; FORCE makes it apply even to the table owner
-- (sms_app), preventing the most common production breach pattern.
--
-- All three policies follow the same shape: tenantId must match the
-- session-bound app.current_tenant_id GUC. WITH CHECK makes them
-- bidirectional — a session bound to tenant A cannot insert/update a row
-- claiming tenantId = B. The ::uuid cast forces a loud error when the
-- GUC is missing.
-- =============================================================================

ALTER TABLE "student" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "student"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE "guardian" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guardian" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "guardian"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE "guardian_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guardian_link" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "guardian_link"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);
