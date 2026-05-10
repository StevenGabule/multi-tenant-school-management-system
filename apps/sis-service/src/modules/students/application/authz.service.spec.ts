import { ForbiddenException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../prisma/prisma.service';
import { StudentRepository } from '../domain/repositories/student.repository';
import { AuthzService } from './authz.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PARENT_USER = '22222222-2222-4222-8222-222222222222';
const STUDENT_OWNED = '33333333-3333-4333-8333-333333333333';
const STUDENT_OTHER = '44444444-4444-4444-8444-444444444444';

interface FakeCls {
  get: jest.Mock;
}
interface FakePrisma {
  $queryRawUnsafe: jest.Mock;
}

function harness(roles: string[], userId: string | null) {
  const cls = {
    get: jest.fn((key: string) => {
      if (key === 'roles') return roles;
      if (key === 'userId') return userId;
      if (key === 'tenantId') return TENANT;
      return undefined;
    }),
  } as unknown as ClsService & FakeCls;
  const prisma = {
    // The actual SQL call returns boolean for is_guardian_of. The
    // service treats `rows[0]?.ok === true` as allowed.
    $queryRawUnsafe: jest.fn(),
  } as unknown as PrismaService & FakePrisma;
  const students = {} as unknown as StudentRepository;
  return {
    cls: cls as unknown as ClsService & FakeCls,
    prisma: prisma as unknown as PrismaService & FakePrisma,
    svc: new AuthzService(
      cls as unknown as ClsService,
      prisma as unknown as PrismaService,
      students,
    ),
  };
}

describe('AuthzService.assertCanAccessStudent', () => {
  it('allows district-admin without consulting guardian_link', async () => {
    const h = harness(['district-admin'], 'admin-user-id');
    await expect(
      h.svc.assertCanAccessStudent(STUDENT_OWNED),
    ).resolves.toBeUndefined();
    expect(h.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('allows school-admin and teacher (RLS still does tenant isolation)', async () => {
    for (const role of ['school-admin', 'teacher']) {
      const h = harness([role], 'staff-user-id');
      await expect(
        h.svc.assertCanAccessStudent(STUDENT_OWNED),
      ).resolves.toBeUndefined();
      expect(h.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    }
  });

  it('parent: allows when guardian_link exists (function returns true)', async () => {
    const h = harness(['parent'], PARENT_USER);
    h.prisma.$queryRawUnsafe.mockResolvedValueOnce([{ ok: true }]);
    await expect(
      h.svc.assertCanAccessStudent(STUDENT_OWNED),
    ).resolves.toBeUndefined();
    expect(h.prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('app.is_guardian_of'),
      STUDENT_OWNED,
      PARENT_USER,
    );
  });

  it('parent: 403 when guardian_link missing (function returns false)', async () => {
    const h = harness(['parent'], PARENT_USER);
    h.prisma.$queryRawUnsafe.mockResolvedValueOnce([{ ok: false }]);
    await expect(
      h.svc.assertCanAccessStudent(STUDENT_OTHER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('parent: 403 when no userId in CLS', async () => {
    const h = harness(['parent'], null);
    await expect(
      h.svc.assertCanAccessStudent(STUDENT_OWNED),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('unknown role: 403', async () => {
    const h = harness(['unknown'], 'whoever');
    await expect(
      h.svc.assertCanAccessStudent(STUDENT_OWNED),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('empty roles: 403', async () => {
    const h = harness([], 'whoever');
    await expect(
      h.svc.assertCanAccessStudent(STUDENT_OWNED),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
