-- =============================================================================
-- Migration: add multi-tenancy
--
-- Introduces the Tenant registry and makes health_check tenant-scoped.
-- The Tenant table itself is NOT RLS-scoped — it's the directory.
-- From this migration forward, every tenant-scoped table must:
--   1. Carry tenantId UUID NOT NULL with FK to tenant(id)
--   2. Be ENABLE + FORCE ROW LEVEL SECURITY
--   3. Have a tenant_isolation policy on app.current_tenant_id
-- =============================================================================

-- The placeholder health_check rows from milestone 1.0 cannot be backfilled
-- to a tenant — they predate tenancy. Nothing in production wrote here.
TRUNCATE TABLE "health_check";

-- CreateTable: Tenant registry
CREATE TABLE "tenant" (
    "id"        UUID         NOT NULL,
    "name"      TEXT         NOT NULL,
    "slug"      TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- AlterTable: health_check becomes tenant-scoped + soft-deletable
ALTER TABLE "health_check"
    ADD COLUMN "deletedAt" TIMESTAMP(3),
    ADD COLUMN "tenantId"  UUID NOT NULL;

CREATE INDEX "health_check_tenantId_idx" ON "health_check"("tenantId");

ALTER TABLE "health_check"
    ADD CONSTRAINT "health_check_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security on health_check
--
-- ENABLE turns RLS on for non-owner roles.
-- FORCE makes it apply EVEN to the table owner — without this, the role
-- that runs migrations bypasses every policy. That's the most common
-- production RLS misconfiguration.
--
-- The tenant_isolation policy reads app.current_tenant_id (a GUC set per
-- request via SET LOCAL inside a transaction). Cast to ::uuid so a missing
-- GUC fails LOUDLY ("invalid input syntax for type uuid") instead of
-- silently matching '' = '' (which would return zero rows, often mistaken
-- for "no data").
--
-- WITH CHECK makes the policy bidirectional: a session bound to tenant A
-- cannot INSERT a row claiming tenantId = B either. Read AND write enforced.
-- =============================================================================

ALTER TABLE "health_check" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "health_check" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "health_check"
    USING      ("tenantId" = current_setting('app.current_tenant_id')::uuid)
    WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);

-- Restrictive policy AND-combines with the permissive one above. SELECTs
-- never return soft-deleted rows; we don't need to remember `WHERE
-- deletedAt IS NULL` in every query. UPDATE/DELETE intentionally NOT
-- restricted here — soft-deleting and restoring still need to see the row.
CREATE POLICY active_only ON "health_check" AS RESTRICTIVE
    FOR SELECT USING ("deletedAt" IS NULL);

-- NOTE: the tenant table is intentionally NOT under RLS.
-- It's the registry — every service consults it on startup. Access
-- control there is service-layer authentication, not row visibility.
-- (When tenant moves to its own control-plane DB in milestone 1.2,
-- this stays true.)
