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

  // Liveness probe — the process is up. Does NOT touch the database.
  // A DB outage must not restart the pod; that's the readiness probe's job.
  @Get('livez')
  @HttpCode(200)
  livez() {
    return { status: 'alive', uptime: Math.round(process.uptime()) };
  }

  // Readiness probe — application can serve traffic right now.
  // Fails (503) if the database round-trip fails. Kubernetes will stop
  // sending traffic until this returns 200 again — but will NOT restart.
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
