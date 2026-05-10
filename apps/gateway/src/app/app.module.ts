import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TenantRegistryModule } from '@org/tenant-registry';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from '../auth/auth.module';
import { HealthChecksModule } from '../health-checks/health-checks.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthModule } from '../health/health.module';

// Tenant CRUD lives in tenant-service (sms_control DB) as of milestone 1.2.
// Gateway used to host POST /api/tenants etc. — those endpoints have moved.

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),
    // Tenant registry client (3-layer cache → tenant-service HTTP).
    // Imported BEFORE AuthModule so JwtAuthGuard can inject it.
    TenantRegistryModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseUrl: config.getOrThrow<string>('TENANT_SERVICE_BASE_URL'),
        redisUrl: config.getOrThrow<string>('REDIS_URL'),
        invalidationChannel: config.get<string>('REDIS_INVALIDATION_CHANNEL'),
      }),
    }),
    AuthModule,
    PrismaModule,
    HealthModule,
    HealthChecksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
