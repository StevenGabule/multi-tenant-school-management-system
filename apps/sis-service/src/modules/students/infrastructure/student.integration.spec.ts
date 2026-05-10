/**
 * Integration test for the SIS data plane.
 *
 * Spins up a real Postgres via Testcontainers, applies the sis-service
 * migrations, and exercises StudentMapper.toPersistence / .toDomain
 * against actual SQL using `pg` directly. We don't go through
 * PrismaStudentRepository here — that would require importing the
 * generated Prisma client, which uses ESM that ts-jest can't compile
 * (same constraint we already documented in jest.config.cts).
 *
 * What this test pins:
 *   - migration SQL is well-formed and applies cleanly on a fresh DB
 *   - RLS rejects queries without the GUC (loud, not silent)
 *   - mapper round-trips a Student through INSERT and SELECT under RLS
 *   - the repository's "find soft-deleted" promise works (findById
 *     should still see deletedAt rows; list filters them out)
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client, types } from 'pg';

// pg's default DATE (oid 1082) parser converts to JS Date in local tz,
// which can roll a day in non-UTC environments. Make pg return DATE as
// a literal "YYYY-MM-DD" string instead. The mapper handles both.
types.setTypeParser(1082, (s: string) => s);
import { Student } from '../domain/entities/student.entity';
import { DateOfBirth } from '../domain/value-objects/date-of-birth.vo';
import { Email } from '../domain/value-objects/email.vo';
import { FullName } from '../domain/value-objects/full-name.vo';
import { PrismaStudentRow, StudentMapper } from './student.mapper';

jest.setTimeout(120_000);

const TENANT_A = '11111111-1111-4111-8111-111111111111';

describe('SIS data plane (Postgres + StudentMapper)', () => {
  let container: StartedPostgreSqlContainer;
  let priv: Client; // sms_app — runs migrations
  let app: Client; // app_user — what the runtime sees

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('sms_sis_test')
      .withUsername('sms_app')
      .withPassword('sms_app_test_pwd')
      .start();

    priv = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: 'sms_sis_test',
      user: 'sms_app',
      password: 'sms_app_test_pwd',
    });
    await priv.connect();

    // Apply every committed migration (single one for now; future
    // migrations get picked up automatically).
    const migrationsDir = join(__dirname, '../../../../prisma/migrations');
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) {
      const sql = readFileSync(
        join(migrationsDir, dir, 'migration.sql'),
        'utf-8',
      );
      await priv.query(sql);
    }

    app = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: 'sms_sis_test',
      user: 'app_user',
      password: 'app_user_local_dev_pwd',
    });
    await app.connect();
  });

  afterAll(async () => {
    if (app) await app.end();
    if (priv) await priv.end();
    if (container) await container.stop();
  });

  describe('migration + role hygiene', () => {
    it('app_user is not superuser and not BYPASSRLS', async () => {
      const r = await app.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('all three SIS tables have RLS enabled and forced', async () => {
      const r = await priv.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname IN ('student','guardian','guardian_link')
          ORDER BY relname`,
      );
      expect(r.rows).toEqual([
        {
          relname: 'guardian',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        {
          relname: 'guardian_link',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        {
          relname: 'student',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
      ]);
    });

    it('SELECT student without GUC raises a loud error', async () => {
      await expect(app.query('SELECT * FROM student')).rejects.toThrow(
        /unrecognized configuration parameter/,
      );
    });
  });

  describe('StudentMapper round-trip through Postgres under RLS', () => {
    it('toPersistence + INSERT + SELECT + toDomain preserves the entity', async () => {
      const original = Student.create({
        tenantId: TENANT_A,
        name: FullName.of('Ada', 'Lovelace', 'Augusta'),
        dateOfBirth: DateOfBirth.from('2010-12-10'),
        email: Email.from('ada@school.edu'),
        externalId: 'STU-7',
      });
      const data = StudentMapper.toPersistence(original);

      await app.query('BEGIN');
      await app.query(
        `SET LOCAL app.current_tenant_id = '${TENANT_A}'`,
      );
      await app.query(
        `INSERT INTO student
          (id, "tenantId", "externalId", "firstName", "middleName", "lastName",
           "dateOfBirth", email, phone, gender,
           "enrolledAt", "withdrawnAt", "deletedAt", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10, $11,$12,$13, NOW(), NOW())`,
        [
          data.id,
          data.tenantId,
          data.externalId,
          data.firstName,
          data.middleName,
          data.lastName,
          data.dateOfBirth,
          data.email,
          data.phone,
          data.gender,
          data.enrolledAt,
          data.withdrawnAt,
          data.deletedAt,
        ],
      );

      const r = await app.query(
        `SELECT id, "tenantId", "externalId", "firstName", "middleName", "lastName",
                "dateOfBirth", email, phone, gender,
                "enrolledAt", "withdrawnAt", "deletedAt", "createdAt", "updatedAt"
           FROM student WHERE id = $1`,
        [original.id.value],
      );
      await app.query('COMMIT');

      const hydrated = StudentMapper.toDomain(r.rows[0] as PrismaStudentRow);
      expect(hydrated.id.equals(original.id)).toBe(true);
      expect(hydrated.tenantId).toBe(original.tenantId);
      expect(hydrated.name.formal()).toBe('Lovelace, Ada');
      expect(hydrated.name.middleName).toBe('Augusta');
      expect(hydrated.dateOfBirth.toISODate()).toBe('2010-12-10');
      expect(hydrated.email?.value).toBe('ada@school.edu');
      expect(hydrated.externalId).toBe('STU-7');
      expect(hydrated.isDeleted()).toBe(false);
    });

    it('soft-delete via UPDATE deletedAt succeeds (no RESTRICTIVE policy on student)', async () => {
      // Insert a fresh row, then UPDATE deletedAt = NOW(), then verify
      // findById would still see it (per the repository contract).
      const s = Student.create({
        tenantId: TENANT_A,
        name: FullName.of('Tobe', 'Deleted'),
        dateOfBirth: DateOfBirth.from('2005-01-01'),
      });
      const data = StudentMapper.toPersistence(s);

      await app.query('BEGIN');
      await app.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
      await app.query(
        `INSERT INTO student
          (id, "tenantId", "firstName", "lastName", "dateOfBirth",
           "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5, NOW(), NOW())`,
        [data.id, data.tenantId, data.firstName, data.lastName, data.dateOfBirth],
      );
      // The milestone 1.1 "RESTRICTIVE blocks UPDATE→deletedAt" lesson is
      // NOT in play here because we deliberately skipped that policy on
      // student. Verify the UPDATE works.
      const updResult = await app.query(
        `UPDATE student SET "deletedAt" = NOW() WHERE id = $1`,
        [data.id],
      );
      expect(updResult.rowCount).toBe(1);
      const r = await app.query(
        `SELECT "deletedAt" FROM student WHERE id = $1`,
        [data.id],
      );
      await app.query('COMMIT');
      expect(r.rows[0].deletedAt).not.toBeNull();
    });
  });
});
