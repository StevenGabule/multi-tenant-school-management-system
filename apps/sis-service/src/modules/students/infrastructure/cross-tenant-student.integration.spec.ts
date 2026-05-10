/**
 * Cross-tenant safety net for sis-service.
 *
 * Same shape as milestone 1.1's gateway cross-tenant test, but for the
 * student/guardian/guardian_link tables. If any assertion fails, treat
 * it as P0 — the multi-tenant guarantee is broken at the SIS data plane
 * and no application code can compensate.
 *
 * The Step 9 integration test pinned the migration + mapper. THIS test
 * pins the cross-tenant security floor.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client, types } from 'pg';

types.setTypeParser(1082, (s: string) => s);
jest.setTimeout(120_000);

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('Cross-tenant isolation on student / guardian / guardian_link', () => {
  let container: StartedPostgreSqlContainer;
  let priv: Client; // sms_app
  let app: Client; // app_user

  let aStudentId: string;
  let bStudentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('sms_sis_xtenant')
      .withUsername('sms_app')
      .withPassword('sms_app_test_pwd')
      .start();

    priv = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: 'sms_sis_xtenant',
      user: 'sms_app',
      password: 'sms_app_test_pwd',
    });
    await priv.connect();

    const migrationsDir = join(__dirname, '../../../../prisma/migrations');
    for (const dir of readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()) {
      const sql = readFileSync(
        join(migrationsDir, dir, 'migration.sql'),
        'utf-8',
      );
      await priv.query(sql);
    }

    app = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: 'sms_sis_xtenant',
      user: 'app_user',
      password: 'app_user_local_dev_pwd',
    });
    await app.connect();

    // Seed one student per tenant
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
    const a = await app.query(
      `INSERT INTO student (id,"tenantId","firstName","lastName","dateOfBirth","createdAt","updatedAt")
       VALUES (gen_random_uuid(), $1, 'Ada', 'Lovelace', '2010-12-10', NOW(), NOW())
       RETURNING id`,
      [TENANT_A],
    );
    aStudentId = a.rows[0].id;
    await app.query('COMMIT');

    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_B}'`);
    const b = await app.query(
      `INSERT INTO student (id,"tenantId","firstName","lastName","dateOfBirth","createdAt","updatedAt")
       VALUES (gen_random_uuid(), $1, 'Alan', 'Turing', '2009-06-23', NOW(), NOW())
       RETURNING id`,
      [TENANT_B],
    );
    bStudentId = b.rows[0].id;
    await app.query('COMMIT');
  });

  afterAll(async () => {
    if (app) await app.end();
    if (priv) await priv.end();
    if (container) await container.stop();
  });

  it("tenant A's SELECT * sees only A's students", async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
    const r = await app.query('SELECT id, "tenantId" FROM student');
    await app.query('COMMIT');
    expect(r.rows.every((row) => row.tenantId === TENANT_A)).toBe(true);
    expect(r.rows.some((row) => row.id === aStudentId)).toBe(true);
    expect(r.rows.some((row) => row.id === bStudentId)).toBe(false);
  });

  it("tenant A's findById of B's student returns 0 rows (no PK leak)", async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
    const r = await app.query('SELECT * FROM student WHERE id = $1', [
      bStudentId,
    ]);
    await app.query('COMMIT');
    expect(r.rows).toHaveLength(0);
  });

  it("tenant A's UPDATE on B's student affects 0 rows", async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
    const r = await app.query(
      `UPDATE student SET "firstName" = 'hijacked' WHERE id = $1`,
      [bStudentId],
    );
    await app.query('COMMIT');
    expect(r.rowCount).toBe(0);
  });

  it("tenant A INSERT claiming B's tenantId is rejected (WITH CHECK)", async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
    await expect(
      app.query(
        `INSERT INTO student (id,"tenantId","firstName","lastName","dateOfBirth","createdAt","updatedAt")
         VALUES (gen_random_uuid(), $1, 'A', 'pretending-B', '2010-01-01', NOW(), NOW())`,
        [TENANT_B],
      ),
    ).rejects.toThrow(/violates row-level security policy/);
    await app.query('ROLLBACK');
  });

  it("tenant A's DELETE on B's student affects 0 rows", async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
    const r = await app.query('DELETE FROM student WHERE id = $1', [
      bStudentId,
    ]);
    await app.query('COMMIT');
    expect(r.rowCount).toBe(0);
  });

  it('guardian + guardian_link tables share the same isolation', async () => {
    // Quick spot-check on the other two RLS'd tables.
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
    const g = await app.query(
      `INSERT INTO guardian (id,"tenantId","firstName","lastName","relationship","createdAt","updatedAt")
       VALUES (gen_random_uuid(), $1, 'Annabella', 'Milbanke', 'parent', NOW(), NOW())
       RETURNING id`,
      [TENANT_A],
    );
    const guardianId = g.rows[0].id;
    await app.query(
      `INSERT INTO guardian_link ("studentId", "guardianId", "tenantId", "isPrimary", "createdAt")
       VALUES ($1, $2, $3, true, NOW())`,
      [aStudentId, guardianId, TENANT_A],
    );
    await app.query('COMMIT');

    // B's session sees neither
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_B}'`);
    const seenG = await app.query('SELECT id FROM guardian WHERE id = $1', [
      guardianId,
    ]);
    const seenL = await app.query(
      'SELECT * FROM guardian_link WHERE "studentId" = $1',
      [aStudentId],
    );
    await app.query('COMMIT');
    expect(seenG.rows).toHaveLength(0);
    expect(seenL.rows).toHaveLength(0);
  });
});
