-- =============================================================================
-- Migration: enrollment + processed_request tables for academic-service
--
-- enrollment: confirmed assignment of a student to a class. Created
--             synchronously by the saga's confirm-enrollment step
--             (POST /api/enrollments). Distinct from enrollment_slot
--             which the event consumer creates async as a placeholder.
--
-- processed_request: HTTP idempotency table. Same shape and rationale
--                    as sis-service's. Used by IdempotencyInterceptor
--                    on POST/DELETE /api/enrollments.
--
-- Both are tenant-scoped under RLS+FORCE.
-- =============================================================================

CREATE TABLE "enrollment" (
    "id"        UUID         NOT NULL,
    "tenantId"  UUID         NOT NULL,
    "studentId" UUID         NOT NULL,
    "classId"   UUID         NOT NULL,
    "status"    TEXT         NOT NULL DEFAULT 'confirmed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "processed_request" (
    "tenantId"       UUID         NOT NULL,
    "idempotencyKey" TEXT         NOT NULL,
    "statusCode"     INTEGER      NOT NULL,
    "responseBody"   JSONB        NOT NULL,
    "status"         TEXT         NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"    TIMESTAMP(3),
    CONSTRAINT "processed_request_pkey" PRIMARY KEY ("tenantId","idempotencyKey")
);

CREATE INDEX "enrollment_tenantId_studentId_idx"
  ON "enrollment"("tenantId", "studentId");
CREATE INDEX "enrollment_tenantId_classId_idx"
  ON "enrollment"("tenantId", "classId");
CREATE INDEX "processed_request_createdAt_idx"
  ON "processed_request"("createdAt");

ALTER TABLE "enrollment"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollment"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "processed_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processed_request" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "enrollment"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON "processed_request"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);
