-- =============================================================================
-- Migration: add transactional outbox to sis-service
--
-- The outbox is the durable hop between "we updated the database" and "we
-- published the event". Producers (CreateStudentUseCase + future use cases)
-- INSERT into outbox_event in the SAME transaction as their state change.
-- The OutboxRelay polls this table (every ~1s) and publishes via Postgres
-- NOTIFY. See ADR-0009.
--
-- Tenant-scoped + RLS-enforced: application code can only append events
-- for its current tenant (matches how everything else in this DB works).
-- The relay itself bypasses RLS — it runs as sms_app (BYPASSRLS) so it
-- can drain the queue across all tenants. See OutboxRelay implementation.
-- =============================================================================

CREATE TABLE "outbox_event" (
    "id"            UUID         NOT NULL,
    "tenantId"      UUID         NOT NULL,
    "aggregateId"   UUID         NOT NULL,
    "aggregateType" TEXT         NOT NULL,
    "eventType"     TEXT         NOT NULL,
    "payload"       JSONB        NOT NULL,
    "metadata"      JSONB        NOT NULL DEFAULT '{}',
    "occurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt"   TIMESTAMP(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- Relay polling lookup: WHERE processedAt IS NULL ORDER BY occurredAt
CREATE INDEX "outbox_event_processedAt_occurredAt_idx"
  ON "outbox_event"("processedAt", "occurredAt");

-- Per-aggregate replay / debugging
CREATE INDEX "outbox_event_aggregateId_occurredAt_idx"
  ON "outbox_event"("aggregateId", "occurredAt");

-- =============================================================================
-- RLS: same shape as student / guardian / guardian_link.
-- =============================================================================

ALTER TABLE "outbox_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_event" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "outbox_event"
  USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);
