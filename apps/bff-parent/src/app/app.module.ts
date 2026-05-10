import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KeycloakModule } from '@org/auth-keycloak';
import { TenantRegistryModule } from '@org/tenant-registry';
import { ClsModule } from 'nestjs-cls';
import { DashboardModule } from '../dashboard/dashboard.module';
import { HealthModule } from '../health/health.module';

// bff-parent does NOT own a database. It composes responses from SIS,
// academic, and (future) notification + communications. Auth is the
// shared @org/auth-keycloak guard. The optional Redis cache layer is
// wired in DashboardModule.

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
    TenantRegistryModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseUrl: config.getOrThrow<string>('TENANT_SERVICE_BASE_URL'),
        redisUrl: config.getOrThrow<string>('REDIS_URL'),
        invalidationChannel: config.get<string>('REDIS_INVALIDATION_CHANNEL'),
      }),
    }),
    KeycloakModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        issuerUrl: config.getOrThrow<string>('KEYCLOAK_ISSUER_URL'),
        audience: config.getOrThrow<string>('KEYCLOAK_AUDIENCE'),
      }),
    }),
    HealthModule,
    DashboardModule,
  ],
})
export class AppModule {}
