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

// Strict UUID validator. tenantId originates in a JWT claim that we
// trust to be sane, but we re-validate at every entry to a SET LOCAL
// to prevent any code path from injecting raw text into a SQL session.
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
    const connectionString = config.getOrThrow<string>('DATABASE_URL');
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }

  /**
   * Run `fn` inside a transaction with `app.current_tenant_id` set to
   * `tenantId` via SET LOCAL. RLS policies on tenant-scoped tables will
   * filter every read and reject every write that doesn't match.
   *
   * SET LOCAL (not SET) is the only safe form under PgBouncer transaction
   * mode — see ADR-0005. The setting evaporates on COMMIT/ROLLBACK.
   *
   * Also pushes tenantId into CLS so any code further down the call stack
   * can read it without re-threading the parameter.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new BadRequestException(
        `withTenant requires a valid UUID tenantId; got "${tenantId}"`,
      );
    }
    return this.cls.runWith({ tenantId }, async () =>
      this.$transaction(async (tx) => {
        // Postgres custom GUCs accept arbitrary text — our UUID regex above
        // is the input gate. We use $executeRawUnsafe because the RHS must
        // be a literal (parameters aren't allowed for SET).
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_tenant_id = '${tenantId}'`,
        );
        return fn(tx);
      }),
    );
  }

  /**
   * Convenience: pull tenantId from CLS (set by JwtAuthGuard) and call
   * withTenant. Throws if CLS has no tenantId — which means the caller
   * is in a route that didn't go through the guard, or in a worker that
   * forgot to seed CLS from the job payload.
   */
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

  /**
   * Returns the tenantId currently in CLS, or null if none is set.
   * Useful for assertions and audit logging.
   */
  currentTenantId(): string | null {
    return this.cls.get<string>('tenantId') ?? null;
  }
}
