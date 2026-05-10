-- =============================================================================
-- Migration: HTTP idempotency table for sis-service
--
-- Used by the IdempotencyInterceptor on endpoints called by the
-- enrollment saga (and any other clients that pass Idempotency-Key).
--
-- Tenant-scoped under RLS so cross-tenant key collisions can't leak
-- response bodies.
-- =============================================================================

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

CREATE INDEX "processed_request_createdAt_idx" ON "processed_request"("createdAt");

ALTER TABLE "processed_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processed_request" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "processed_request"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);
