import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  TenantStatus,
  TenantTier,
  type Tenant,
} from '../generated/prisma/client';

export interface CreateTenantInput {
  name: string;
  slug: string;
  tier?: TenantTier;
  region?: string;
  planId?: string | null;
}

export interface UpdateTenantInput {
  name?: string;
  tier?: TenantTier;
  region?: string;
  status?: TenantStatus;
  planId?: string | null;
  dsn?: string | null;
}

/**
 * Tenant registry operations. Every mutation:
 *   1. Bumps `version` (cache invalidation hint for downstream registry
 *      clients — milestone 1.2 step 5).
 *   2. Appends a TenantEvent (audit trail; reconstructable history).
 *   3. Runs in a single transaction (event + tenant update atomic).
 *
 * The Redis pub/sub invalidation broadcast comes in step 8 as a
 * post-commit side effect of these methods. For now, the version bump
 * + the TenantEvent are the durable record.
 */
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateTenantInput, actorId?: string): Promise<Tenant> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tenant.findUnique({
        where: { slug: input.slug },
      });
      if (existing) {
        throw new ConflictException(`tenant slug already in use: ${input.slug}`);
      }
      const tenant = await tx.tenant.create({
        data: {
          name: input.name,
          slug: input.slug,
          tier: input.tier ?? TenantTier.pool,
          region: input.region ?? 'us-east-1',
          status: TenantStatus.active,
          planId: input.planId ?? null,
          version: 1,
        },
      });
      await tx.tenantEvent.create({
        data: {
          tenantId: tenant.id,
          type: 'created',
          payload: {
            name: input.name,
            slug: input.slug,
            tier: tenant.tier,
            region: tenant.region,
          },
          actorId: actorId ?? null,
        },
      });
      return tenant;
    });
  }

  async list(): Promise<Tenant[]> {
    // Pagination intentionally deferred until we have enough tenants to
    // need it. Real cap planned for milestone 1.7 BFF aggregation.
    return this.prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { id } });
  }

  findBySlug(slug: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { slug } });
  }

  async update(
    id: string,
    patch: UpdateTenantInput,
    actorId?: string,
  ): Promise<Tenant> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tenant.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException(`tenant not found: ${id}`);
      const updated = await tx.tenant.update({
        where: { id },
        data: { ...patch, version: { increment: 1 } },
      });
      await tx.tenantEvent.create({
        data: {
          tenantId: id,
          type: 'updated',
          payload: { patch, fromVersion: existing.version, toVersion: updated.version },
          actorId: actorId ?? null,
        },
      });
      return updated;
    });
  }

  async suspend(id: string, reason?: string, actorId?: string): Promise<Tenant> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tenant.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException(`tenant not found: ${id}`);
      if (existing.status === TenantStatus.suspended) {
        return existing; // idempotent
      }
      const updated = await tx.tenant.update({
        where: { id },
        data: {
          status: TenantStatus.suspended,
          suspendedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await tx.tenantEvent.create({
        data: {
          tenantId: id,
          type: 'suspended',
          payload: { reason: reason ?? null, fromStatus: existing.status },
          actorId: actorId ?? null,
        },
      });
      return updated;
    });
  }

  async activate(id: string, actorId?: string): Promise<Tenant> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tenant.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException(`tenant not found: ${id}`);
      if (existing.status === TenantStatus.active) {
        return existing; // idempotent
      }
      const updated = await tx.tenant.update({
        where: { id },
        data: {
          status: TenantStatus.active,
          suspendedAt: null,
          version: { increment: 1 },
        },
      });
      await tx.tenantEvent.create({
        data: {
          tenantId: id,
          type: 'activated',
          payload: { fromStatus: existing.status },
          actorId: actorId ?? null,
        },
      });
      return updated;
    });
  }
}
