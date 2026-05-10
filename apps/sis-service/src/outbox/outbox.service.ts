import { Injectable, Logger } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';
import type { TenantTx } from '../prisma/prisma.service';

export interface AppendOutboxParams {
  /** UUID of the aggregate the event belongs to (e.g., studentId). */
  aggregateId: string;
  /** Aggregate type name (e.g., "Student"). */
  aggregateType: string;
  /** Dotted event name (e.g., "student.created"). */
  eventType: string;
  /** JSON-serializable event body. */
  payload: Record<string, unknown>;
  /**
   * Tenant the event belongs to. Required because the producer might be
   * running in a system context (workers) where CLS isn't set; passing
   * it explicitly keeps the contract clear.
   */
  tenantId: string;
  /** Schema version of the event payload. Defaults to 1. */
  schemaVersion?: number;
}

/**
 * Helper for appending domain events to the transactional outbox.
 *
 * Always called WITH a Prisma transaction client (not the global Prisma
 * service) so the event row commits in the SAME tx as the state change.
 * If the tx rolls back, the event row rolls back too — that's the entire
 * point of the outbox pattern (no dual-write failure mode).
 *
 * Captures the OTel trace context as `metadata.traceparent` so the
 * consumer can continue the trace; the producer's span and the consumer's
 * span show up as one logical workflow in Jaeger.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly cls: ClsService) {}

  async append(tx: TenantTx, params: AppendOutboxParams): Promise<void> {
    // Snapshot the active OTel context into a plain object so we can
    // store it in JSONB. The consumer passes it back to propagation.extract
    // to continue the trace.
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);

    const metadata = {
      ...carrier, // traceparent, tracestate, baggage
      tenantId: params.tenantId,
      schemaVersion: params.schemaVersion ?? 1,
      // Audit trail bits — reach into CLS if available; fall through if
      // not (e.g., events emitted from workers seeded only with tenantId).
      userId: this.cls.get<string>('userId') ?? null,
      requestId: this.cls.get<string>('requestId') ?? null,
    };

    await tx.outboxEvent.create({
      data: {
        tenantId: params.tenantId,
        aggregateId: params.aggregateId,
        aggregateType: params.aggregateType,
        eventType: params.eventType,
        payload: params.payload as object,
        metadata,
      },
    });

    this.logger.debug(
      `outbox <- ${params.eventType} (${params.aggregateType}:${params.aggregateId})`,
    );
  }
}
