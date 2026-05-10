import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Identical to sis-service's IdempotencyInterceptor. Will be deduplicated
 * in milestone 1.6 alongside the auth-guard refactor (a libs/http-common
 * extraction is the natural moment).
 *
 * See sis-service/src/common/idempotency.interceptor.ts for full design
 * notes.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
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
    }>();
    const res = context.switchToHttp().getResponse<{ statusCode?: number }>();
    const key = req.headers['idempotency-key'];
    if (!key) return next.handle();

    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new ConflictException(
        'Idempotency-Key requires authenticated tenant context',
      );
    }

    return from(this.claim(tenantId, key)).pipe(
      switchMap((claim) => {
        if (claim.kind === 'cached') {
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

  private async claim(
    tenantId: string,
    key: string,
  ): Promise<
    | { kind: 'fresh' }
    | { kind: 'cached'; statusCode: number; responseBody: unknown }
  > {
    return this.prisma.withTenant(tenantId, async (tx) => {
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
      if (!existing) return { kind: 'fresh' as const };
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
