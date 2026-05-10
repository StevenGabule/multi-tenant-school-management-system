import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RegistryEventsModule } from '../events/registry-events.module';
import { HealthModule } from '../health/health.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TenantsModule } from '../tenants/tenants.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),
    PrismaModule,
    RegistryEventsModule,
    HealthModule,
    TenantsModule,
  ],
})
export class AppModule {}
