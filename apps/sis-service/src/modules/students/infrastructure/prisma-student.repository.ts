import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Student } from '../domain/entities/student.entity';
import {
  StudentListFilter,
  StudentRepository,
} from '../domain/repositories/student.repository';
import { StudentId } from '../domain/value-objects/student-id.vo';
import { PrismaStudentRow, StudentMapper } from './student.mapper';

/**
 * Prisma-backed implementation of StudentRepository.
 *
 * Every method goes through prisma.withCurrentTenant — opens a tx,
 * sets `SET LOCAL app.current_tenant_id` from CLS, then runs queries.
 * RLS filters all reads, WITH CHECK blocks all cross-tenant writes.
 *
 * The tenantId in CLS comes from the JwtAuthGuard, which got it from
 * a signature-verified JWT and validated it against the registry. The
 * full chain: JWT → guard → CLS → withCurrentTenant → SET LOCAL → RLS.
 */
@Injectable()
export class PrismaStudentRepository implements StudentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: StudentId): Promise<Student | null> {
    return this.prisma.withCurrentTenant(async (tx) => {
      const row = (await tx.student.findUnique({
        where: { id: id.value },
      })) as PrismaStudentRow | null;
      return row ? StudentMapper.toDomain(row) : null;
    });
  }

  async findByExternalId(externalId: string): Promise<Student | null> {
    return this.prisma.withCurrentTenant(async (tx) => {
      // The unique key is (tenantId, externalId); RLS scopes the query
      // automatically, so we only pass externalId. Prisma needs the
      // compound unique key shape — we synthesize tenantId from CLS.
      const tenantId = this.prisma.currentTenantId();
      if (!tenantId) return null;
      const row = (await tx.student.findUnique({
        where: { tenantId_externalId: { tenantId, externalId } },
      })) as PrismaStudentRow | null;
      return row ? StudentMapper.toDomain(row) : null;
    });
  }

  async list(filter: StudentListFilter = {}): Promise<Student[]> {
    const limit = Math.min(filter.limit ?? 50, 200);
    return this.prisma.withCurrentTenant(async (tx) => {
      const where: Record<string, unknown> = {};
      if (!filter.includeDeleted) where['deletedAt'] = null;
      if (filter.search) {
        where['OR'] = [
          { firstName: { contains: filter.search, mode: 'insensitive' } },
          { lastName: { contains: filter.search, mode: 'insensitive' } },
        ];
      }
      const rows = (await tx.student.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: limit,
      })) as PrismaStudentRow[];
      return rows.map(StudentMapper.toDomain);
    });
  }

  async save(student: Student): Promise<void> {
    const data = StudentMapper.toPersistence(student);
    await this.prisma.withCurrentTenant(async (tx) => {
      // Upsert by id. WITH CHECK on the tenant_isolation policy will
      // reject the write if data.tenantId doesn't match the CLS tenant
      // (e.g., bug in the application layer trying to save another
      // tenant's student). Defense in depth.
      await tx.student.upsert({
        where: { id: data.id },
        create: data,
        update: data,
      });
    });
  }
}
