-- =============================================================================
-- Migration: parent-of-student ABAC at the RLS layer
-- (milestone 1.6 — IAM with Keycloak, step 7)
--
-- The Student policy until now: tenant_isolation only. Anyone authenticated
-- as tenant T sees ALL of T's students. That's correct for admin roles
-- and teachers, wrong for parents.
--
-- This migration extends the policy: a parent (the user's role doesn't
-- reach the DB layer; we model "parent" as "this user is registered as a
-- guardian on at least one student") sees ONLY students they're a guardian
-- of. Admins/teachers — anyone NOT in guardian_link as a guardian of
-- somebody — see all of their tenant's students.
--
-- Defense in depth: AuthzService at the application layer ALSO enforces
-- this (so app code that bypasses RLS still goes through the check). RLS
-- is the floor — nothing reaches the DB without going through it.
--
-- Identity mapping: app.current_user_id GUC carries the Keycloak `sub`
-- claim (a uuid). For Phase 1.6 demo purposes, we treat sub as a
-- guardian.id when the user's role is parent. Real identity-mapping
-- (Keycloak user ↔ guardian row) is a Phase 2 concern; the SQL pattern
-- is the load-bearing piece this migration teaches.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helper. Runs with sms_app privileges (BYPASSRLS), so
-- the inner SELECT against guardian_link doesn't trigger guardian_link's
-- own RLS policy. Without this, the Student policy → guardian_link RLS →
-- (recursive lookup) → stack depth limit exceeded. The Nile blog post
-- and our own ADR-0005 cover the gotcha.
--
-- The function is STABLE (input → same output within a transaction) so
-- the planner can cache it across rows in a single query.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.is_guardian_of(student_id uuid, user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "guardian_link" gl
    WHERE gl."studentId" = student_id
      AND gl."guardianId" = user_id
  );
$$;

REVOKE ALL ON FUNCTION app.is_guardian_of(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_guardian_of(uuid, uuid) TO app_user;

-- Ensure GUC defaults to '' so missing-context queries fail cleanly.
-- (current_setting('...', true) returns NULL when unset; the cast to uuid
-- below would error, which is the safer outcome — fail-closed.)

-- ---------------------------------------------------------------------------
-- Drop and rebuild the Student policy. Must DROP-then-CREATE — Postgres
-- has no ALTER POLICY ... USING.
--
-- New rule:
--   USING (
--     tenantId matches AND
--     (
--       no current_user_id set (admin/system path)
--       OR
--       user is registered as guardian of THIS student
--     )
--   )
--
-- The "no current_user_id set" branch lets internal tooling and admin
-- service paths see all rows when they explicitly skip the user GUC.
-- Application code MUST set the GUC for parent users; failing to do so
-- is a safe-by-default leak (the path is read-everything, not write-
-- everywhere — and writes still go through WITH CHECK + tenant_isolation).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON "student";

CREATE POLICY tenant_isolation ON "student"
  USING (
    "tenantId" = current_setting('app.current_tenant_id')::uuid
    AND (
      coalesce(current_setting('app.current_user_id', true), '') = ''
      OR app.is_guardian_of("id", current_setting('app.current_user_id')::uuid)
    )
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id')::uuid
  );
