import { Inject, Injectable } from '@nestjs/common';
import { StudentNotFound } from '../domain/errors';
import {
  STUDENT_REPOSITORY,
  StudentRepository,
} from '../domain/repositories/student.repository';
import { StudentId } from '../domain/value-objects/student-id.vo';

@Injectable()
export class SoftDeleteStudentUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly repo: StudentRepository,
  ) {}

  async execute(id: string): Promise<void> {
    const studentId = StudentId.from(id);
    const student = await this.repo.findById(studentId);
    if (!student) throw new StudentNotFound(id);
    student.softDelete();
    await this.repo.save(student);
  }
}

@Injectable()
export class RestoreStudentUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly repo: StudentRepository,
  ) {}

  async execute(id: string): Promise<void> {
    const studentId = StudentId.from(id);
    const student = await this.repo.findById(studentId);
    if (!student) throw new StudentNotFound(id);
    student.restore();
    await this.repo.save(student);
  }
}
