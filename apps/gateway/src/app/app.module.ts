import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from '../prisma/prisma.module';

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
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
