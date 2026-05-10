-- =============================================================================
-- Migration: initial enrollment-service schema (milestone 1.5 — Enrollment Saga)
--
-- Two tables, both tenant-scoped under RLS:
--   • saga_instance — one row per saga (durable state machine)
--   • saga_step    — one row per step in a saga (per-step status + output)
--
-- The saga executor (worker process) connects as sms_app (BYPASSRLS) to
-- claim sagas via FOR UPDATE SKIP LOCKED across all tenants. Application
-- code (the POST /api/enrollments controller) writes under app_user with
-- RLS enforcing "tenant A can only insert/read its own sagas."
-- =============================================================================

CREATE TABLE "saga_instance" (
    "id"          UUID         NOT NULL,
    "tenantId"    UUID         NOT NULL,
    "type"        TEXT         NOT NULL,
    "status"      TEXT         NOT NULL,
    "currentStep" INTEGER      NOT NULL DEFAULT 0,
    "totalSteps"  INTEGER      NOT NULL,
    "payload"     JSONB        NOT NULL,
    "lastError"   JSONB,
    "retryCount"  INTEGER      NOT NULL DEFAULT 0,
    "startedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "saga_instance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "saga_step" (
    "id"            UUID         NOT NULL,
    "sagaId"        UUID         NOT NULL,
    "stepIndex"     INTEGER      NOT NULL,
    "name"          TEXT         NOT NULL,
    "status"        TEXT         NOT NULL,
    "attempts"      INTEGER      NOT NULL DEFAULT 0,
    "output"        JSONB,
    "error"         JSONB,
    "startedAt"     TIMESTAMP(3),
    "completedAt"   TIMESTAMP(3),
    "compensatedAt" TIMESTAMP(3),
    CONSTRAINT "saga_step_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saga_instance_status_startedAt_idx"
  ON "saga_instance"("status", "startedAt");
CREATE INDEX "saga_instance_tenantId_status_idx"
  ON "saga_instance"("tenantId", "status");
CREATE INDEX "saga_step_sagaId_status_idx"
  ON "saga_step"("sagaId", "status");
CREATE UNIQUE INDEX "saga_step_sagaId_stepIndex_key"
  ON "saga_step"("sagaId", "stepIndex");

ALTER TABLE "saga_step"
  ADD CONSTRAINT "saga_step_sagaId_fkey"
  FOREIGN KEY ("sagaId") REFERENCES "saga_instance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- app_user role + grants on this DB (idempotent, per-DB pattern from sms_sis
-- and sms_academic). Roles are cluster-wide; grants are per-database.
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
-- RLS on both tables. Same tenant_isolation policy used elsewhere — reads
-- and writes both gated on app.current_tenant_id.
--
-- Why both tables: a malicious tenant could otherwise enumerate other
-- tenants' saga progress by reading saga_step directly (sagaId is a UUID
-- but discoverable through join paths in higher-privilege code paths).
-- The defensive posture: if it's tenant-derived, it's RLS'd.
-- =============================================================================

ALTER TABLE "saga_instance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saga_instance" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "saga_instance"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);

-- saga_step doesn't carry tenantId itself (it joins via sagaId), so its
-- isolation is via the parent's tenantId. We add a denormalized policy
-- using a subquery — performant because sagaId is indexed and the saga
-- row is hot.
ALTER TABLE "saga_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saga_step" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "saga_step"
  USING (
    EXISTS (
      SELECT 1 FROM "saga_instance" si
      WHERE si."id" = "saga_step"."sagaId"
        AND si."tenantId" = current_setting('app.current_tenant_id')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "saga_instance" si
      WHERE si."id" = "saga_step"."sagaId"
        AND si."tenantId" = current_setting('app.current_tenant_id')::uuid
    )
  );
