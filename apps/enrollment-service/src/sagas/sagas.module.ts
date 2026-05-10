import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CrossServiceClient } from './cross-service.client';
import { EnrollmentSaga } from './enrollment.saga';
import { SagaExecutor } from './saga.executor';

@Module({
  imports: [AuthModule], // for JwtModule (re-exported)
  providers: [CrossServiceClient, EnrollmentSaga, SagaExecutor],
  exports: [CrossServiceClient, EnrollmentSaga, SagaExecutor],
})
export class SagasModule {}
