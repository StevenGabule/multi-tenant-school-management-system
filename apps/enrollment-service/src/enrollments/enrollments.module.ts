import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SagasModule } from '../sagas/sagas.module';
import { EnrollmentsController } from './enrollments.controller';

@Module({
  imports: [AuthModule, SagasModule],
  controllers: [EnrollmentsController],
})
export class EnrollmentsModule {}
