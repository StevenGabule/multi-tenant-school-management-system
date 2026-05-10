import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService, TenantTx } from '../prisma/prisma.service';

/**
 * Every tenant-aware job payload MUST carry tenantId. Audit-relevant
 * context (userId, requestId) flows through too so logs/traces tie back
 * to the original request that enqueued the job.
 */
export interface TenantAwareJobPayload {
  tenantId: string;
  userId?: string;
  requestId?: string;
}

/**
 * Base class for ANY background worker that touches tenant-scoped data.
 *
 * Why this exists: workers run outside the HTTP request lifecycle, so
 * JwtAuthGuard never fires and CLS is empty when the job pulls off the
 * queue. Without this guard, calls to tenant-scoped tables would either
 * fail at the DB (RLS, loud) or — worse — succeed with the WRONG tenant
 * context if some prior tx left a GUC set. Either way the failure mode
 * is hostile to debugging.
 *
 * The convention this enforces:
 *   1. Every job payload includes tenantId (extends TenantAwareJobPayload).
 *   2. The base class's `run()` is the single entry point. It:
 *      - throws loudly if tenantId is missing (fail-fast)
 *      - seeds CLS with tenant + actor context
 *      - opens a Prisma tx with `SET LOCAL app.current_tenant_id`
 *      - calls the subclass's process(payload, tx) inside that tx
 *   3. Subclass overrides `process(payload, tx)` — receiving `tx`
 *      makes it visually obvious that all DB work must go through the
 *      tenant-scoped transaction client.
 *
 * Will be exercised in milestones 1.4 (outbox consumers) and 1.5
 * (saga steps). For now, the convention exists so those milestones
 * inherit it without retrofitting workers that already shipped.
 *
 * Future CI lint rule: any `@Processor()`-decorated class that doesn't
 * extend TenantAwareProcessor fails the build.
 */
export abstract class TenantAwareProcessor<
  P extends TenantAwareJobPayload = TenantAwareJobPayload,
> {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly cls: ClsService,
  ) {}

  /**
   * Subclass implements the actual job logic here. `tx` already has
   * app.current_tenant_id bound — every Prisma call through it is
   * tenant-scoped.
   */
  protected abstract process(payload: P, tx: TenantTx): Promise<unknown>;

  /**
   * Entry point. Wire your queue's job handler to call this:
   *
   *   @Processor('emails')
   *   class WelcomeEmailProcessor extends TenantAwareProcessor<WelcomeJob> {
   *     @Process()
   *     handle(job: Job<WelcomeJob>) {
   *       return this.run(job.data);
   *     }
   *     protected async process(payload, tx) { ... }
   *   }
   */
  async run(payload: P): Promise<unknown> {
    if (!payload?.tenantId) {
      throw new Error(
        `${this.constructor.name}: job payload missing tenantId — refusing to process. ` +
          `Workers MUST set tenantId in the payload at enqueue time so RLS can apply.`,
      );
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', payload.tenantId);
      if (payload.userId) this.cls.set('userId', payload.userId);
      if (payload.requestId) this.cls.set('requestId', payload.requestId);
      return this.prisma.withTenant(payload.tenantId, (tx) =>
        this.process(payload, tx),
      );
    });
  }
}
