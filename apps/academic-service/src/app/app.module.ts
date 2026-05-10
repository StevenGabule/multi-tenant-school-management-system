import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConsumersModule } from '../consumers/consumers.module';
import { HealthModule } from '../health/health.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),
    PrismaModule,
    HealthModule,
    ConsumersModule,
  ],
})
export class AppModule {}
