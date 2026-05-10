import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

interface CreateCheckBody {
  status?: string;
}

/**
 * Tenant-scoped CRUD on health_check.
 *
 * Every method goes through:
 *   1. JwtAuthGuard — validates Bearer JWT, pushes tenantId into CLS.
 *   2. prisma.withCurrentTenant — opens a tx, SET LOCAL app.current_tenant_id,
 *      runs the callback. RLS on health_check filters reads + WITH CHECK
 *      blocks writes that don't match.
 *
 * If the guard ever fails to set CLS (it shouldn't, but defense in depth),
 * withCurrentTenant throws BEFORE Prisma is touched. If somehow we DO touch
 * Prisma without a tenant, RLS at the DB blocks everything.
 */
@Controller('health-checks')
@UseGuards(JwtAuthGuard)
export class HealthChecksController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateCheckBody) {
    return this.prisma.withCurrentTenant(async (tx) => {
      const tenantId = this.prisma.currentTenantId() as string;
      return tx.healthCheck.create({
        data: {
          tenantId,
          status: body.status ?? 'ok',
        },
        select: { id: true, status: true, checkedAt: true, tenantId: true },
      });
    });
  }

  @Get()
  async list() {
    return this.prisma.withCurrentTenant(async (tx) => {
      return tx.healthCheck.findMany({
        orderBy: { checkedAt: 'desc' },
        select: { id: true, status: true, checkedAt: true, tenantId: true },
      });
    });
  }
}
