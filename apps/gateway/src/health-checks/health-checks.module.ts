import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HealthChecksController } from './health-checks.controller';

@Module({
  imports: [AuthModule],
  controllers: [HealthChecksController],
})
export class HealthChecksModule {}
