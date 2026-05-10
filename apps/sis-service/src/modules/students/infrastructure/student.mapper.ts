import { Student, StudentSnapshot } from '../domain/entities/student.entity';

/**
 * Pure-function translator between the Prisma row shape and the domain
 * Student aggregate. The ONLY place where these two types meet.
 *
 * If Prisma's `student` model ever drifts from the snapshot shape, this
 * file is the single point of repair — every other consumer goes through
 * Student.toSnapshot() / reconstitute().
 */

// Loose Prisma row type to avoid depending on the generated client type
// here (the generated client uses ESM that ts-jest can't process during
// unit tests; keeping the mapper structural keeps unit tests happy).
export interface PrismaStudentRow {
  id: string;
  tenantId: string;
  externalId: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: Date;
  email: string | null;
  phone: string | null;
  gender: string | null;
  enrolledAt: Date | null;
  withdrawnAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const StudentMapper = {
  toDomain(row: PrismaStudentRow): Student {
    const snap: StudentSnapshot = {
      id: row.id,
      tenantId: row.tenantId,
      externalId: row.externalId,
      firstName: row.firstName,
      middleName: row.middleName,
      lastName: row.lastName,
      dateOfBirth: row.dateOfBirth.toISOString().slice(0, 10),
      email: row.email,
      phone: row.phone,
      gender: row.gender,
      enrolledAt: row.enrolledAt,
      withdrawnAt: row.withdrawnAt,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return Student.reconstitute(snap);
  },

  /**
   * Builds the Prisma data object for create/update. Prisma accepts
   * `Date` for `@db.Date` columns; we parse the snapshot's ISO date
   * string back to midnight-UTC Date.
   */
  toPersistence(student: Student) {
    const snap = student.toSnapshot();
    return {
      id: snap.id,
      tenantId: snap.tenantId,
      externalId: snap.externalId,
      firstName: snap.firstName,
      middleName: snap.middleName,
      lastName: snap.lastName,
      dateOfBirth: new Date(`${snap.dateOfBirth}T00:00:00.000Z`),
      email: snap.email,
      phone: snap.phone,
      gender: snap.gender,
      enrolledAt: snap.enrolledAt,
      withdrawnAt: snap.withdrawnAt,
      deletedAt: snap.deletedAt,
      // createdAt is Prisma-managed; updatedAt is also Prisma-managed.
      // The aggregate's _updatedAt is for in-memory tracking only.
    };
  },
};
