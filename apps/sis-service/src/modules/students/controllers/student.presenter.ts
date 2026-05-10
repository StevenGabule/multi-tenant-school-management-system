import { Student } from '../domain/entities/student.entity';

/**
 * Domain entity → wire shape. Keeping this separate from Student.toSnapshot
 * (which is for persistence) means renaming an entity field doesn't
 * silently change the API contract — the wire shape only changes when
 * THIS file changes.
 */
export function toStudentResponse(student: Student) {
  return {
    id: student.id.value,
    tenantId: student.tenantId,
    externalId: student.externalId,
    firstName: student.name.firstName,
    middleName: student.name.middleName,
    lastName: student.name.lastName,
    dateOfBirth: student.dateOfBirth.toISODate(),
    email: student.email?.value ?? null,
    phone: student.phone?.value ?? null,
    gender: student.gender,
    isDeleted: student.isDeleted(),
    createdAt: student.createdAt.toISOString(),
    updatedAt: student.updatedAt.toISOString(),
  };
}
