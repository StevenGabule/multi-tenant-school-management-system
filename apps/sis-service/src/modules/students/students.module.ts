import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { IdempotencyInterceptor } from '../../common/idempotency.interceptor';
import { AuthzService } from './application/authz.service';
import { CreateStudentUseCase } from './application/create-student.use-case';
import {
  FindStudentByIdUseCase,
  ListStudentsUseCase,
} from './application/find-student.use-case';
import {
  RestoreStudentUseCase,
  SoftDeleteStudentUseCase,
} from './application/soft-delete-student.use-case';
import { UpdateStudentUseCase } from './application/update-student.use-case';
import { StudentsController } from './controllers/students.controller';
import { STUDENT_REPOSITORY } from './domain/repositories/student.repository';
import { PrismaStudentRepository } from './infrastructure/prisma-student.repository';

@Module({
  imports: [AuthModule],
  controllers: [StudentsController],
  providers: [
    AuthzService,
    CreateStudentUseCase,
    FindStudentByIdUseCase,
    ListStudentsUseCase,
    UpdateStudentUseCase,
    SoftDeleteStudentUseCase,
    RestoreStudentUseCase,
    PrismaStudentRepository,
    IdempotencyInterceptor,
    // Bind the domain interface to the Prisma implementation. Tests
    // override this provider with InMemoryStudentRepository.
    { provide: STUDENT_REPOSITORY, useExisting: PrismaStudentRepository },
  ],
})
export class StudentsModule {}
