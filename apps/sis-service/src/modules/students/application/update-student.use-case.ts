import { Inject, Injectable } from '@nestjs/common';
import { Student } from '../domain/entities/student.entity';
import { StudentNotFound } from '../domain/errors';
import {
  STUDENT_REPOSITORY,
  StudentRepository,
} from '../domain/repositories/student.repository';
import { Email } from '../domain/value-objects/email.vo';
import { FullName } from '../domain/value-objects/full-name.vo';
import { Phone } from '../domain/value-objects/phone.vo';
import { StudentId } from '../domain/value-objects/student-id.vo';

export interface UpdateStudentInput {
  firstName?: string;
  lastName?: string;
  middleName?: string | null;
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
}

/**
 * One method covers both rename + contact + externalId because they
 * share the "load → mutate → save" shape and run in a single transaction
 * via withCurrentTenant.
 */
@Injectable()
export class UpdateStudentUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly repo: StudentRepository,
  ) {}

  async execute(id: string, patch: UpdateStudentInput): Promise<Student> {
    const studentId = StudentId.from(id);
    const student = await this.repo.findById(studentId);
    if (!student) throw new StudentNotFound(id);

    if (
      patch.firstName !== undefined ||
      patch.lastName !== undefined ||
      patch.middleName !== undefined
    ) {
      const next = FullName.of(
        patch.firstName ?? student.name.firstName,
        patch.lastName ?? student.name.lastName,
        patch.middleName !== undefined ? patch.middleName : student.name.middleName,
      );
      student.rename(next);
    }

    if (patch.email !== undefined || patch.phone !== undefined) {
      student.updateContact({
        email:
          patch.email === undefined
            ? undefined
            : patch.email === null
              ? null
              : Email.from(patch.email),
        phone:
          patch.phone === undefined
            ? undefined
            : patch.phone === null
              ? null
              : Phone.from(patch.phone),
      });
    }

    if (patch.externalId !== undefined) {
      student.recordExternalId(patch.externalId);
    }

    await this.repo.save(student);
    return student;
  }
}
