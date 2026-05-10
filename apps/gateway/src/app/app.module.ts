import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from '../auth/auth.module';
import { HealthChecksModule } from '../health-checks/health-checks.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthModule } from '../health/health.module';
import { TenantsModule } from '../tenants/tenants.module';

@Module({
  imports: [
    // Load .env.local first (developer-edited), then .env (committed defaults).
    // ConfigModule populates process.env synchronously during module loading,
    // so PrismaService can read DATABASE_URL in its constructor.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),
    AuthModule,
    PrismaModule,
    HealthModule,
    TenantsModule,
    HealthChecksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
