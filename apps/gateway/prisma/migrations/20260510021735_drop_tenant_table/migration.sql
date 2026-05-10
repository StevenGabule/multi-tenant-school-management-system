-- =============================================================================
-- Migration: drop tenant table from gateway DB
--
-- The tenant registry moved to tenant-service (sms_control DB) in milestone
-- 1.2. Gateway no longer owns Tenant rows. health_check.tenantId remains
-- a UUID column — but it's now a "logical reference" to rows in another
-- database. NO FK enforcement.
--
-- The tenant-registry client (@org/tenant-registry) validates the ID
-- against tenant-service on every authenticated request, before any
-- query runs. The cross-tenant integration test continues to pin the
-- RLS-level enforcement on health_check.
-- =============================================================================

ALTER TABLE "health_check" DROP CONSTRAINT "health_check_tenantId_fkey";

DROP TABLE "tenant";
