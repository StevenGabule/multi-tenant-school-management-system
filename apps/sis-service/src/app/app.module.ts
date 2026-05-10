import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TenantRegistryModule } from '@org/tenant-registry';
import { AuthModule } from '../auth/auth.module';
import { HealthModule } from '../health/health.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StudentsModule } from '../modules/students/students.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
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
    AuthModule,
    PrismaModule,
    OutboxModule,
    HealthModule,
    StudentsModule,
  ],
})
export class AppModule {}
