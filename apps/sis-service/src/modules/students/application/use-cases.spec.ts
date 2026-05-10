import { ClsService } from 'nestjs-cls';
import { OutboxService } from '../../../outbox/outbox.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { StudentNotFound } from '../domain/errors';
import { InvariantViolation } from '../domain/errors';
import { CreateStudentUseCase } from './create-student.use-case';
import {
  FindStudentByIdUseCase,
  ListStudentsUseCase,
} from './find-student.use-case';
import { InMemoryStudentRepository } from './in-memory-student.repository';
import {
  RestoreStudentUseCase,
  SoftDeleteStudentUseCase,
} from './soft-delete-student.use-case';
import { UpdateStudentUseCase } from './update-student.use-case';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function buildHarness() {
  const repo = new InMemoryStudentRepository();
  // Minimal PrismaService stub — InMemoryStudentRepository doesn't touch
  // Prisma, but CreateStudentUseCase reads currentTenantId() and calls
  // withCurrentTenant() to wrap the save + outbox in one tx.
  const prisma = {
    currentTenantId: () => TENANT_ID,
    withCurrentTenant: async <T>(
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> => fn('FAKE_TX'),
  } as unknown as PrismaService;
  // OutboxService stub — record what gets appended so the create test
  // can assert the event payload.
  const outbox = {
    appended: [] as unknown[],
    append: jest.fn(async function (
      this: { appended: unknown[] },
      _tx,
      params,
    ) {
      this.appended.push(params);
    }),
  };
  const cls = {
    get: () => TENANT_ID,
  } as unknown as ClsService;
  void cls;
  return {
    repo,
    outbox,
    create: new CreateStudentUseCase(
      repo,
      prisma,
      outbox as unknown as OutboxService,
    ),
    findById: new FindStudentByIdUseCase(repo),
    list: new ListStudentsUseCase(repo),
    update: new UpdateStudentUseCase(repo),
    softDelete: new SoftDeleteStudentUseCase(repo),
    restore: new RestoreStudentUseCase(repo),
  };
}

describe('CreateStudentUseCase', () => {
  it('persists a student and returns it', async () => {
    const h = buildHarness();
    const s = await h.create.execute({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '2010-12-10',
      email: 'ada@school.edu',
    });
    expect(s.tenantId).toBe(TENANT_ID);
    expect(s.name.formal()).toBe('Lovelace, Ada');
    expect(h.repo.size()).toBe(1);
  });

  it('rejects malformed input via value-object invariants', async () => {
    const h = buildHarness();
    await expect(
      h.create.execute({
        firstName: '',
        lastName: 'Lovelace',
        dateOfBirth: '2010-12-10',
      }),
    ).rejects.toBeInstanceOf(InvariantViolation);
  });

  it('appends a student.created outbox event in the same tx', async () => {
    const h = buildHarness();
    const s = await h.create.execute({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '2010-12-10',
    });
    expect(h.outbox.append).toHaveBeenCalledTimes(1);
    expect(h.outbox.appended).toHaveLength(1);
    const event = h.outbox.appended[0] as Record<string, unknown>;
    expect(event.eventType).toBe('student.created');
    expect(event.aggregateType).toBe('Student');
    expect(event.aggregateId).toBe(s.id.value);
    expect(event.tenantId).toBe(TENANT_ID);
    expect((event.payload as Record<string, string>).studentId).toBe(s.id.value);
  });
});

describe('FindStudentByIdUseCase / ListStudentsUseCase', () => {
  it('finds an existing student', async () => {
    const h = buildHarness();
    const s = await h.create.execute({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '2010-12-10',
    });
    const found = await h.findById.execute(s.id.value);
    expect(found.id.equals(s.id)).toBe(true);
  });

  it('throws StudentNotFound on miss', async () => {
    const h = buildHarness();
    await expect(
      h.findById.execute('99999999-9999-4999-8999-999999999999'),
    ).rejects.toBeInstanceOf(StudentNotFound);
  });

  it('list excludes soft-deleted by default; includeDeleted opts in', async () => {
    const h = buildHarness();
    const a = await h.create.execute({
      firstName: 'Ada',
      lastName: 'A',
      dateOfBirth: '2010-01-01',
    });
    await h.create.execute({
      firstName: 'Bob',
      lastName: 'B',
      dateOfBirth: '2010-01-01',
    });
    await h.softDelete.execute(a.id.value);

    const visible = await h.list.execute();
    expect(visible.map((s) => s.name.lastName)).toEqual(['B']);

    const all = await h.list.execute({ includeDeleted: true });
    expect(all).toHaveLength(2);
  });
});

describe('UpdateStudentUseCase', () => {
  it('renames + updates contact in one shot', async () => {
    const h = buildHarness();
    const s = await h.create.execute({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '2010-12-10',
    });
    const updated = await h.update.execute(s.id.value, {
      lastName: 'King-Lovelace',
      email: 'augusta@school.edu',
    });
    expect(updated.name.lastName).toBe('King-Lovelace');
    expect(updated.email?.value).toBe('augusta@school.edu');
  });

  it('partial: undefined fields stay unchanged', async () => {
    const h = buildHarness();
    const s = await h.create.execute({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '2010-12-10',
      email: 'ada@school.edu',
    });
    await h.update.execute(s.id.value, { lastName: 'King' });
    const found = await h.findById.execute(s.id.value);
    expect(found.email?.value).toBe('ada@school.edu'); // untouched
    expect(found.name.lastName).toBe('King');
  });

  it('email: null clears, omitted leaves alone', async () => {
    const h = buildHarness();
    const s = await h.create.execute({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '2010-12-10',
      email: 'ada@school.edu',
    });
    await h.update.execute(s.id.value, { email: null });
    const found = await h.findById.execute(s.id.value);
    expect(found.email).toBeNull();
  });

  it('throws StudentNotFound on unknown id', async () => {
    const h = buildHarness();
    await expect(
      h.update.execute('99999999-9999-4999-8999-999999999999', {
        firstName: 'X',
      }),
    ).rejects.toBeInstanceOf(StudentNotFound);
  });
});

describe('SoftDelete + Restore use cases', () => {
  it('soft-deletes then restores', async () => {
    const h = buildHarness();
    const s = await h.create.execute({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '2010-12-10',
    });
    await h.softDelete.execute(s.id.value);
    expect((await h.findById.execute(s.id.value)).isDeleted()).toBe(true);
    await h.restore.execute(s.id.value);
    expect((await h.findById.execute(s.id.value)).isDeleted()).toBe(false);
  });

  it('soft-delete is idempotent', async () => {
    const h = buildHarness();
    const s = await h.create.execute({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '2010-12-10',
    });
    await h.softDelete.execute(s.id.value);
    const t1 = (await h.findById.execute(s.id.value)).deletedAt;
    await h.softDelete.execute(s.id.value);
    const t2 = (await h.findById.execute(s.id.value)).deletedAt;
    expect(t2).toEqual(t1);
  });
});
