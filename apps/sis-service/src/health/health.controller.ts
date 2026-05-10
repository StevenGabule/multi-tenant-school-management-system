import {
  Controller,
  Get,
  HttpCode,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('livez')
  @HttpCode(200)
  livez() {
    return { status: 'alive', uptime: Math.round(process.uptime()) };
  }

  @Get('readyz')
  @HttpCode(200)
  async readyz() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'reachable' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`readyz failed: ${message}`);
      throw new ServiceUnavailableException({
        status: 'unready',
        database: 'unreachable',
        error: message,
      });
    }
  }
}
