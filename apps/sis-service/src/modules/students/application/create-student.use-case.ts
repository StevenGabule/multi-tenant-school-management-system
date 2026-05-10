import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Student } from '../domain/entities/student.entity';
import {
  STUDENT_REPOSITORY,
  StudentRepository,
} from '../domain/repositories/student.repository';
import { DateOfBirth } from '../domain/value-objects/date-of-birth.vo';
import { Email } from '../domain/value-objects/email.vo';
import { FullName } from '../domain/value-objects/full-name.vo';
import { Phone } from '../domain/value-objects/phone.vo';

export interface CreateStudentInput {
  firstName: string;
  lastName: string;
  middleName?: string | null;
  dateOfBirth: string; // ISO YYYY-MM-DD
  externalId?: string | null;
  email?: string | null;
  phone?: string | null;
  gender?: string | null;
}

@Injectable()
export class CreateStudentUseCase {
  constructor(
    @Inject(STUDENT_REPOSITORY) private readonly repo: StudentRepository,
    private readonly prisma: PrismaService,
  ) {}

  async execute(input: CreateStudentInput): Promise<Student> {
    const tenantId = this.prisma.currentTenantId();
    if (!tenantId) {
      throw new Error('CreateStudentUseCase requires a tenant in CLS');
    }

    const student = Student.create({
      tenantId,
      name: FullName.of(input.firstName, input.lastName, input.middleName),
      dateOfBirth: DateOfBirth.from(input.dateOfBirth),
      externalId: input.externalId ?? null,
      email: input.email ? Email.from(input.email) : null,
      phone: input.phone ? Phone.from(input.phone) : null,
      gender: input.gender ?? null,
    });

    await this.repo.save(student);
    return student;
  }
}
