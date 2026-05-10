import { Inject, Injectable } from '@nestjs/common';
import { Student } from '../domain/entities/student.entity';
import { StudentNotFound } from '../domain/errors';
import {
  STUDENT_REPOSITORY,
  StudentListFilter,
  StudentRepository,
} from '../domain/repositories/student.repository';
import { StudentId } from '../domain/value-objects/student-id.vo';
import { AuthzService } from './authz.service';

@Injectable()
export class FindStudentByIdUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly repo: StudentRepository,
    private readonly authz: AuthzService,
  ) {}

  async execute(id: string): Promise<Student> {
    // Application-layer ABAC: throws 403 explicitly when the principal
    // is a parent NOT linked to this student. RLS also enforces this
    // (defense in depth) but RLS would surface as a "not found" 404,
    // which leaks no info but also doesn't help operators distinguish
    // bug-vs-attempted-access.
    await this.authz.assertCanAccessStudent(id);
    const studentId = StudentId.from(id);
    const student = await this.repo.findById(studentId);
    if (!student) throw new StudentNotFound(id);
    return student;
  }
}

@Injectable()
export class ListStudentsUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly repo: StudentRepository,
  ) {}

  execute(filter: StudentListFilter = {}): Promise<Student[]> {
    return this.repo.list(filter);
  }
}
