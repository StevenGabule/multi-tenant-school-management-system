import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  imports: [
    // CLS namespaces hold per-request tenantId, userId, requestId, etc.
    // Middleware (next step) sets tenantId from the validated JWT.
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
  ],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
