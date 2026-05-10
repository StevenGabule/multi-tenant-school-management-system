import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../outbox/outbox.service';
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
    private readonly outbox: OutboxService,
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

    // Save + outbox MUST be atomic. If the outbox append fails, the
    // student insert rolls back too — no orphaned student rows that
    // never produced an event, no events for students that never
    // committed. This is the entire point of the outbox pattern.
    await this.prisma.withCurrentTenant(async (tx) => {
      await this.repo.save(student, tx);
      await this.outbox.append(tx, {
        tenantId,
        aggregateType: 'Student',
        aggregateId: student.id.value,
        eventType: 'student.created',
        payload: {
          studentId: student.id.value,
          firstName: student.name.firstName,
          middleName: student.name.middleName,
          lastName: student.name.lastName,
          dateOfBirth: student.dateOfBirth.toISODate(),
          email: student.email?.value ?? null,
          externalId: student.externalId,
        },
      });
    });

    return student;
  }
}
