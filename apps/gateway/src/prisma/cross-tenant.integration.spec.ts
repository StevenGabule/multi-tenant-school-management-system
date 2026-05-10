/**
 * The unbreakable safety net.
 *
 * This test stands up a fresh Postgres via Testcontainers, runs every
 * migration in apps/gateway/prisma/migrations against it, then exercises
 * cross-tenant attempts as the non-superuser app_user role. If any
 * assertion below fails, treat it as a P0 incident — the multi-tenant
 * isolation guarantee is broken at the database level, and no amount
 * of careful application code can compensate.
 *
 * Why this is the most important test in the codebase:
 *   - Application bugs that drop tenant context (forgotten `withTenant`,
 *     a worker that skipped TenantAwareProcessor, a raw query with bad
 *     interpolation) all surface as RLS denials when this test passes.
 *     The RLS policies + WITH CHECK clauses are the floor.
 *   - If a future migration accidentally drops a policy or grants
 *     BYPASSRLS, this test fails before that change can ship.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';

jest.setTimeout(120_000);

const TENANT_A_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_B_ID = '22222222-2222-2222-2222-222222222222';

describe('Cross-tenant isolation (RLS integration)', () => {
  let container: StartedPostgreSqlContainer;
  let migrationClient: Client; // sms_app — superuser, runs DDL + seeds tenants
  let appClient: Client; // app_user — what runtime queries look like

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('sms_test')
      .withUsername('sms_app')
      .withPassword('sms_app_test_pwd')
      .start();

    migrationClient = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: 'sms_test',
      user: 'sms_app',
      password: 'sms_app_test_pwd',
    });
    await migrationClient.connect();

    // Run every committed migration in lexicographic order — same as
    // `prisma migrate deploy` would, but without spawning the CLI.
    const migrationsDir = join(__dirname, '../../prisma/migrations');
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) {
      const sql = readFileSync(
        join(migrationsDir, dir, 'migration.sql'),
        'utf-8',
      );
      await migrationClient.query(sql);
    }

    // No tenant seeding: as of milestone 1.2 the tenant table moved to
    // tenant-service (sms_control DB) and gateway's health_check.tenantId
    // is now a logical reference (no FK). The UUIDs above are therefore
    // arbitrary — RLS only cares that they match the GUC.

    // Connect as the non-superuser role for all assertions below.
    appClient = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: 'sms_test',
      user: 'app_user',
      password: 'app_user_local_dev_pwd',
    });
    await appClient.connect();
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (migrationClient) await migrationClient.end();
    if (container) await container.stop();
  });

  // ───────────────────────────────────────────────────────────────────
  // Role hygiene — the foundation. If app_user ever ends up superuser
  // or BYPASSRLS, every other test below would falsely pass.
  // ───────────────────────────────────────────────────────────────────
  describe('role hygiene', () => {
    it('app_user is NOT superuser and does NOT bypass RLS', async () => {
      const r = await appClient.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('health_check has RLS ENABLED + FORCED', async () => {
      const r = await migrationClient.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'health_check'`,
      );
      expect(r.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // GUC enforcement — queries without tenant context must fail loudly.
  // ───────────────────────────────────────────────────────────────────
  describe('missing GUC', () => {
    it('SELECT without GUC raises an error (not silently returns 0 rows)', async () => {
      await expect(
        appClient.query('SELECT * FROM health_check'),
      ).rejects.toThrow(/unrecognized configuration parameter/);
    });

    it('INSERT without GUC raises an error too', async () => {
      await expect(
        appClient.query(
          `INSERT INTO health_check (id, "tenantId", "checkedAt", status)
           VALUES (gen_random_uuid(), $1, NOW(), 'should-fail')`,
          [TENANT_A_ID],
        ),
      ).rejects.toThrow(/unrecognized configuration parameter/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // The core isolation: tenant A's session can never see tenant B's data.
  // ───────────────────────────────────────────────────────────────────
  describe('tenant scoping', () => {
    let aRowId: string;
    let bRowId: string;

    beforeAll(async () => {
      // Seed one row per tenant
      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A_ID}'`,
      );
      const aIns = await appClient.query(
        `INSERT INTO health_check (id, "tenantId", "checkedAt", status)
         VALUES (gen_random_uuid(), $1, NOW(), 'A-row') RETURNING id`,
        [TENANT_A_ID],
      );
      aRowId = aIns.rows[0].id;
      await appClient.query('COMMIT');

      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_B_ID}'`,
      );
      const bIns = await appClient.query(
        `INSERT INTO health_check (id, "tenantId", "checkedAt", status)
         VALUES (gen_random_uuid(), $1, NOW(), 'B-row') RETURNING id`,
        [TENANT_B_ID],
      );
      bRowId = bIns.rows[0].id;
      await appClient.query('COMMIT');
    });

    it("tenant A's session SELECT * sees only A's rows", async () => {
      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A_ID}'`,
      );
      const r = await appClient.query(
        'SELECT id, "tenantId" FROM health_check',
      );
      await appClient.query('COMMIT');
      expect(r.rows.every((row) => row.tenantId === TENANT_A_ID)).toBe(true);
      expect(r.rows.some((row) => row.id === aRowId)).toBe(true);
      expect(r.rows.some((row) => row.id === bRowId)).toBe(false);
    });

    it("tenant A's session SELECT by B's id returns 0 rows (no leak via primary key)", async () => {
      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A_ID}'`,
      );
      const r = await appClient.query(
        'SELECT * FROM health_check WHERE id = $1',
        [bRowId],
      );
      await appClient.query('COMMIT');
      expect(r.rows).toHaveLength(0);
    });

    it("tenant A's UPDATE on B's row affects 0 rows (RLS hides them)", async () => {
      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A_ID}'`,
      );
      const r = await appClient.query(
        `UPDATE health_check SET status = 'hijacked' WHERE id = $1`,
        [bRowId],
      );
      await appClient.query('COMMIT');
      expect(r.rowCount).toBe(0);
    });

    it("tenant A INSERT claiming B's tenantId is rejected (WITH CHECK)", async () => {
      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A_ID}'`,
      );
      await expect(
        appClient.query(
          `INSERT INTO health_check (id, "tenantId", "checkedAt", status)
           VALUES (gen_random_uuid(), $1, NOW(), 'A-pretending-B')`,
          [TENANT_B_ID],
        ),
      ).rejects.toThrow(/violates row-level security policy/);
      await appClient.query('ROLLBACK');
    });

    it("tenant A's DELETE on B's row affects 0 rows", async () => {
      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A_ID}'`,
      );
      const r = await appClient.query(
        `DELETE FROM health_check WHERE id = $1`,
        [bRowId],
      );
      await appClient.query('COMMIT');
      expect(r.rowCount).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Soft-delete: AS RESTRICTIVE policy hides deletedAt rows by default.
  // ───────────────────────────────────────────────────────────────────
  describe('soft-delete + RESTRICTIVE policy interaction (lesson learned)', () => {
    /**
     * The active_only policy is RESTRICTIVE FOR SELECT. Even though it
     * names FOR SELECT, Postgres ALSO checks it on INSERT/UPDATE — to
     * prevent commands from producing rows the current user would not
     * be able to read back. That's a security protection (no "write-only
     * sinkhole") but it makes the obvious soft-delete-via-UPDATE
     * pattern impossible: you cannot UPDATE deletedAt = NOW() on a
     * visible row, because the new row would fail active_only.
     *
     * Two production-ready paths to soft-delete with this policy in place:
     *   a) Drop the RESTRICTIVE active_only policy and filter
     *      `WHERE deletedAt IS NULL` in application queries.
     *   b) A privileged "soft_delete()" SQL function with SECURITY
     *      DEFINER that bypasses RLS for the deletedAt write only.
     *
     * For Phase 1.1 we KEEP the policy — it correctly demonstrates
     * RESTRICTIVE composition, and the test below pins the behavior
     * so we don't ship a soft-delete that silently fails some other way.
     */
    it('hides direct INSERT of an already-deleted row (RETURNING fails)', async () => {
      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A_ID}'`,
      );
      await expect(
        appClient.query(
          `INSERT INTO health_check (id, "tenantId", "checkedAt", status, "deletedAt")
           VALUES (gen_random_uuid(), $1, NOW(), 'born-deleted', NOW())
           RETURNING id`,
          [TENANT_A_ID],
        ),
      ).rejects.toThrow(/violates row-level security policy "active_only"/);
      await appClient.query('ROLLBACK');
    });

    it('rejects UPDATE that would set deletedAt (would hide row from its author)', async () => {
      await appClient.query('BEGIN');
      await appClient.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A_ID}'`,
      );
      const ins = await appClient.query(
        `INSERT INTO health_check (id, "tenantId", "checkedAt", status)
         VALUES (gen_random_uuid(), $1, NOW(), 'will-not-soft-delete')
         RETURNING id`,
        [TENANT_A_ID],
      );
      const id = ins.rows[0].id;
      await expect(
        appClient.query(
          `UPDATE health_check SET "deletedAt" = NOW() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/violates row-level security policy "active_only"/);
      await appClient.query('ROLLBACK');
    });
  });
});
