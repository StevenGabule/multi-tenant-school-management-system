-- =============================================================================
-- Migration: initial academic-service schema
--
-- Two tables:
--   • enrollment_slot — tenant-scoped, RLS-enforced (the application data)
--   • processed_event — NOT tenant-scoped (consumer-side idempotency
--     bookkeeping; same shape regardless of which tenant emitted the event)
--
-- + app_user role + grants on this DB (per-database; the role exists but
--   this DB needs its own privileges).
-- =============================================================================

CREATE TABLE "enrollment_slot" (
    "id"        UUID         NOT NULL,
    "tenantId"  UUID         NOT NULL,
    "studentId" UUID         NOT NULL,
    "status"    TEXT         NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enrollment_slot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "processed_event" (
    "eventId"      UUID         NOT NULL,
    "consumerName" TEXT         NOT NULL,
    "processedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("eventId", "consumerName")
);

CREATE INDEX "enrollment_slot_tenantId_studentId_idx"
  ON "enrollment_slot"("tenantId", "studentId");
CREATE INDEX "enrollment_slot_tenantId_status_idx"
  ON "enrollment_slot"("tenantId", "status");

-- =============================================================================
-- app_user role + grants on this DB (idempotent, per-DB pattern from sms_sis)
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
-- RLS on enrollment_slot only. processed_event is infrastructure tracking
-- (no tenant column, no isolation requirement) — the consumer is the only
-- writer/reader and it runs as a privileged role.
-- =============================================================================

ALTER TABLE "enrollment_slot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollment_slot" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "enrollment_slot"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);
