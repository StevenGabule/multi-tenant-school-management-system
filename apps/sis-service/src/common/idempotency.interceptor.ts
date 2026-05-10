import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * HTTP-level idempotency. Every request that carries an `Idempotency-Key`
 * header is recorded in `processed_request`; a duplicate key returns the
 * cached prior response without re-running the handler.
 *
 * Lifecycle:
 *
 *   1. First call (key=K):
 *        INSERT processed_request VALUES (tenant, K, status='PENDING', ...)
 *        ON CONFLICT DO NOTHING RETURNING (tenant, K)
 *      If insert succeeds, the handler runs. After response,
 *        UPDATE ... SET status='COMPLETED', responseBody=..., statusCode=...
 *
 *   2. Duplicate (same tenant, same K):
 *        SELECT existing
 *        - If status='COMPLETED' → return the cached body + status
 *        - If status='PENDING'   → 409 Conflict (the original is still
 *                                    in flight; retrying would risk
 *                                    double-effecting)
 *
 *   3. Handler error:
 *        We DO NOT cache error responses. The PENDING row is deleted
 *        in the catch path so the next retry can attempt fresh.
 *        Phase 2 may want to cache 4xx errors (deterministic, safe to
 *        repeat) but cache no 5xx (unsafe — retry might succeed).
 *
 * Tenant scoping: keys are namespaced by tenantId (the table's PK is
 * (tenantId, idempotencyKey)). RLS on the table is the second line of
 * defense. The CLS-set tenantId comes from the JwtAuthGuard that runs
 * before the interceptor.
 *
 * Cleanup: rows accumulate forever today. A cleanup job (DELETE WHERE
 * createdAt < NOW() - INTERVAL '7 days') belongs in Phase 2 alongside
 * the outbox cleanup job.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      method: string;
    }>();
    const res = context.switchToHttp().getResponse<{ statusCode?: number }>();
    const key = req.headers['idempotency-key'];
    if (!key) {
      // Not idempotency-protected — pass through.
      return next.handle();
    }
    // CLS is populated by JwtAuthGuard. The guard runs BEFORE the
    // interceptor, so tenantId is reliably present here.
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      // Defensive: should not happen if guard ran. Fail closed.
      throw new ConflictException(
        'Idempotency-Key requires authenticated tenant context',
      );
    }

    return from(this.claim(tenantId, key)).pipe(
      switchMap((claim) => {
        if (claim.kind === 'cached') {
          // Re-emit the cached response. NestJS will JSON-serialize.
          if (typeof res.statusCode === 'number') {
            res.statusCode = claim.statusCode;
          }
          return of(claim.responseBody);
        }
        return next.handle().pipe(
          tap({
            next: async (response) => {
              await this.complete(
                tenantId,
                key,
                res.statusCode ?? 200,
                response,
              );
            },
            error: async () => {
              await this.releasePending(tenantId, key).catch(() => undefined);
            },
          }),
        );
      }),
    );
  }

  /**
   * Try to claim the key. Returns either:
   *   - 'fresh' (we got the slot; caller runs the handler)
   *   - 'cached' (a prior request completed; return its response)
   * Or throws ConflictException if a prior request is still in flight.
   */
  private async claim(
    tenantId: string,
    key: string,
  ): Promise<
    | { kind: 'fresh' }
    | { kind: 'cached'; statusCode: number; responseBody: unknown }
  > {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Try insert; if conflict, fall back to read.
      const inserted = await tx.$queryRawUnsafe<{ tenantId: string }[]>(
        `INSERT INTO processed_request
           ("tenantId", "idempotencyKey", "statusCode", "responseBody", "status")
         VALUES ($1::uuid, $2, 0, '{}'::jsonb, 'PENDING')
         ON CONFLICT DO NOTHING
         RETURNING "tenantId"`,
        tenantId,
        key,
      );
      if (inserted.length > 0) return { kind: 'fresh' as const };

      const existing = await tx.processedRequest.findUnique({
        where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } },
      });
      if (!existing) {
        // Race: insert lost AND select lost — extremely unlikely, retry.
        return { kind: 'fresh' as const };
      }
      if (existing.status === 'PENDING') {
        throw new ConflictException(
          `idempotency key "${key}" is in flight; retry shortly`,
        );
      }
      return {
        kind: 'cached' as const,
        statusCode: existing.statusCode,
        responseBody: existing.responseBody,
      };
    });
  }

  private async complete(
    tenantId: string,
    key: string,
    statusCode: number,
    response: unknown,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.processedRequest.update({
        where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } },
        data: {
          statusCode,
          responseBody: (response ?? {}) as object,
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
    });
  }

  private async releasePending(tenantId: string, key: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.processedRequest.delete({
        where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } },
      });
    });
  }
}
