import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma client for the control-plane DB (sms_control).
 *
 * Simpler than the gateway's PrismaService: NO RLS, NO withTenant, NO CLS.
 * The tenant table itself isn't tenant-scoped — it IS the registry.
 * Access control here is service-layer authentication (milestone 1.6 adds
 * platform-admin); see ADR-0007.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>(
      'CONTROL_PLANE_DATABASE_URL',
    );
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma (control plane) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma (control plane) disconnected');
  }
}
