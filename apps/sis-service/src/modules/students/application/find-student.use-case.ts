import { Inject, Injectable } from '@nestjs/common';
import { Student } from '../domain/entities/student.entity';
import { StudentNotFound } from '../domain/errors';
import {
  STUDENT_REPOSITORY,
  StudentListFilter,
  StudentRepository,
} from '../domain/repositories/student.repository';
import { StudentId } from '../domain/value-objects/student-id.vo';

@Injectable()
export class FindStudentByIdUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly repo: StudentRepository,
  ) {}

  async execute(id: string): Promise<Student> {
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
