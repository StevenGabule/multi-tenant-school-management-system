import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CrossServiceClient } from './cross-service.client';
import { EnrollmentSaga } from './enrollment.saga';
import { SagaExecutor } from './saga.executor';

@Module({
  // KeycloakModule (loaded via AuthModule) is global so KeycloakService
  // is available without explicit re-import. AuthModule itself is
  // imported for backward compat — once JwtModule is removed in a
  // follow-up cleanup it can drop too.
  imports: [AuthModule],
  providers: [CrossServiceClient, EnrollmentSaga, SagaExecutor],
  exports: [CrossServiceClient, EnrollmentSaga, SagaExecutor],
})
export class SagasModule {}
