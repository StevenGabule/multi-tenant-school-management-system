import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '../generated/prisma/client';

// Mirrors gateway's PrismaService. Will be extracted to a shared
// `libs/prisma-tenant-context` lib in milestone 1.6 (when we refactor
// the auth surface for Keycloak — natural moment to deduplicate the
// withTenant pattern across services).

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TenantTx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    config: ConfigService,
    private readonly cls: ClsService,
  ) {
    const connectionString = config.getOrThrow<string>('SIS_DATABASE_URL');
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma (sis) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma (sis) disconnected');
  }

  async withTenant<T>(
    tenantId: string,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new BadRequestException(
        `withTenant requires a valid UUID tenantId; got "${tenantId}"`,
      );
    }
    // userId from CLS — populated by KeycloakAuthGuard. When present,
    // the parent_abac_rls migration's policy uses it via
    // app.current_user_id GUC for the parent-of-X visibility check.
    // When absent (admin paths, internal jobs), the policy short-
    // circuits to "no user-scope filter" — see migration comments.
    const userId = this.cls.get<string>('userId');
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      if (userId) this.cls.set('userId', userId);
      return this.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_tenant_id = '${tenantId}'`,
        );
        if (userId && UUID_RE.test(userId)) {
          await tx.$executeRawUnsafe(
            `SET LOCAL app.current_user_id = '${userId}'`,
          );
        }
        return fn(tx);
      });
    });
  }

  async withCurrentTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new Error(
        'withCurrentTenant called without tenantId in CLS. ' +
          'Ensure the route is guarded by JwtAuthGuard, or use withTenant(tenantId, ...) directly.',
      );
    }
    return this.withTenant(tenantId, fn);
  }

  currentTenantId(): string | null {
    return this.cls.get<string>('tenantId') ?? null;
  }
}
