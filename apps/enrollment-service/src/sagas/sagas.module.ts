import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CrossServiceClient } from './cross-service.client';
import { EnrollmentSaga } from './enrollment.saga';

@Module({
  imports: [AuthModule], // for JwtModule (re-exported)
  providers: [CrossServiceClient, EnrollmentSaga],
  exports: [CrossServiceClient, EnrollmentSaga],
})
export class SagasModule {}
