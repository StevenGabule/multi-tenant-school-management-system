import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TenantRegistryModule } from '@org/tenant-registry';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { EnrollmentsController } from './enrollments.controller';

// TenantRegistryModule + AuthModule together give the controller a
// working JwtAuthGuard. Note we import TenantRegistryModule here in
// case AppModule isn't already importing it; idempotent under DI.

@Module({
  imports: [
    AuthModule,
    TenantRegistryModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseUrl: config.getOrThrow<string>('TENANT_SERVICE_BASE_URL'),
        redisUrl: config.getOrThrow<string>('REDIS_URL'),
        invalidationChannel: config.get<string>('REDIS_INVALIDATION_CHANNEL'),
      }),
    }),
  ],
  controllers: [EnrollmentsController],
  providers: [IdempotencyInterceptor],
})
export class EnrollmentsModule {}
