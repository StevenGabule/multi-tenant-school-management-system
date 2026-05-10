import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface CreateTenantBody {
  name: string;
  slug: string;
}

/**
 * Tenant administration endpoints.
 *
 * NOTE — milestone 1.1: these endpoints are intentionally unauthenticated
 * because we don't yet have a platform-admin role. In milestone 1.2 the
 * registry moves to a dedicated tenant-service guarded by an API key or
 * service-to-service mTLS, and these go away from the gateway.
 *
 * Tenant rows are NOT under RLS (they're the registry — see ADR-0001 +
 * the migration's policy on tenant). So we use the raw `prisma` client,
 * not `withTenant`.
 */
@Controller('tenants')
export class TenantsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateTenantBody) {
    if (!body.name || !body.slug) {
      throw new Error('name and slug are required');
    }
    const tenant = await this.prisma.tenant.create({
      data: { name: body.name, slug: body.slug },
    });
    return tenant;
  }

  @Get()
  async list() {
    return this.prisma.tenant.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.prisma.tenant.findUnique({ where: { id } });
  }
}
