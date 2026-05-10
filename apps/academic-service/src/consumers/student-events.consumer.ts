import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ROOT_CONTEXT,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';

interface OutboxEnvelope {
  id: string;
  tenantId: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: Record<string, string>;
  occurredAt: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Consumes events emitted by sis-service's OutboxRelay.
 *
 *   ┌─────────────┐   tx commit    ┌────────────┐   pg_notify   ┌──────────┐
 *   │ sis use     │ ───────────►   │ sms_sis    │ ───────────►  │ THIS     │
 *   │ case        │                │ outbox_event              │ consumer │
 *   └─────────────┘                └────────────┘               └──────────┘
 *                                                                   │ withTenant
 *                                                                   ▼
 *                                                              enrollment_slot
 *                                                              processed_event
 *
 * Two clients:
 *   • listenClient: long-lived `pg` Client connected to sms_sis; held
 *     in LISTEN mode for the lifetime of the process. Bypasses
 *     PgBouncer for the same reason as the relay.
 *   • Prisma (this.prisma): writes to academic-service's own DB
 *     (sms_academic) — EnrollmentSlot via withTenant + processed_event
 *     via raw SQL (no RLS on processed_event).
 *
 * Idempotency: each event_id is recorded in processed_event under
 * (eventId, consumerName). The handler runs ONLY if the INSERT was
 * effective (RETURNING confirms a new row). Duplicate deliveries are
 * harmless — the handler is skipped.
 *
 * OTel: extract trace context from event.metadata.traceparent, run
 * handler inside `context.with(extracted, ...)`. The producer's span
 * and the consumer's span show up as one trace in Jaeger.
 *
 * NOT YET IMPLEMENTED — Phase 2:
 *   • Catch-up on startup (query outbox for unprocessed events newer
 *     than our last seen). Today, if the consumer was down when the
 *     relay published, those messages are lost.
 *   • Dead-letter handling (poison message N retries → move to DLQ).
 *   • Metrics emission (per-event latency, error rate).
 */
@Injectable()
export class StudentEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StudentEventsConsumer.name);
  private readonly consumerName = 'academic-student-events';
  private readonly channel: string;
  private readonly listenUrl: string;
  private listenClient: Client | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.channel =
      this.config.get<string>('SIS_OUTBOX_CHANNEL') ?? 'sms.sis.outbox';
    this.listenUrl = this.config.getOrThrow<string>('ACADEMIC_LISTEN_URL');
  }

  async onModuleInit(): Promise<void> {
    this.listenClient = new Client({ connectionString: this.listenUrl });
    await this.listenClient.connect();
    // pg uses double-quotes for the channel since '.' isn't a normal identifier char.
    await this.listenClient.query(`LISTEN "${this.channel}"`);
    this.listenClient.on('notification', (msg) => {
      void this.onNotification(msg.payload ?? '');
    });
    this.listenClient.on('error', (err) => {
      this.logger.error(`listen connection error: ${err.message}`);
    });
    this.logger.log(
      `listening for events on "${this.channel}" (consumer=${this.consumerName})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.listenClient) {
      try {
        await this.listenClient.query(`UNLISTEN "${this.channel}"`);
      } catch {
        /* ignore */
      }
      await this.listenClient.end().catch(() => undefined);
      this.listenClient = null;
    }
  }

  /**
   * Notification entry point. Exported for tests.
   */
  async onNotification(rawPayload: string): Promise<void> {
    let envelope: OutboxEnvelope;
    try {
      envelope = JSON.parse(rawPayload) as OutboxEnvelope;
    } catch (err) {
      this.logger.error(
        `dropping unparseable notification: ${(err as Error).message}`,
      );
      return;
    }
    if (!envelope.id || !UUID_RE.test(envelope.tenantId)) {
      this.logger.error(`dropping malformed envelope (id=${envelope?.id})`);
      return;
    }

    // Continue the producer's trace.
    const parentCtx = propagation.extract(ROOT_CONTEXT, envelope.metadata);
    const tracer = trace.getTracer('academic-service');
    await context.with(parentCtx, async () => {
      const span = tracer.startSpan(`consume:${envelope.eventType}`, {
        attributes: {
          'event.id': envelope.id,
          'event.type': envelope.eventType,
          'tenant.id': envelope.tenantId,
        },
      });
      try {
        await this.process(envelope);
      } catch (err) {
        span.recordException(err as Error);
        this.logger.error(
          `event ${envelope.id} (${envelope.eventType}) failed: ${(err as Error).message}`,
        );
        // Phase 2: move to DLQ after N retries. Today: log and let the
        // next delivery (if it ever happens) try again.
      } finally {
        span.end();
      }
    });
  }

  private async process(envelope: OutboxEnvelope): Promise<void> {
    // Idempotency + handler in ONE transaction. processed_event has no
    // RLS so we set the GUC (for any tenant-scoped writes the handler
    // does) AND insert into processed_event in the same tx.
    await this.prisma.withTenant(envelope.tenantId, async (tx) => {
      const claimed = (await tx.$queryRawUnsafe(
        `INSERT INTO processed_event ("eventId", "consumerName", "processedAt")
         VALUES ($1::uuid, $2, NOW())
         ON CONFLICT DO NOTHING
         RETURNING "eventId"`,
        envelope.id,
        this.consumerName,
      )) as Array<{ eventId: string }>;

      if (claimed.length === 0) {
        // Already processed by a previous delivery — handler is skipped.
        this.logger.debug(`event ${envelope.id} already processed; skipping`);
        return;
      }

      switch (envelope.eventType) {
        case 'student.created':
          await this.onStudentCreated(envelope, tx);
          break;
        default:
          // Unknown event type — recorded as processed (so we don't
          // re-attempt) but no handler runs. Safe default for forward
          // compatibility with new event types from sis-service.
          this.logger.warn(
            `no handler for event type "${envelope.eventType}"; marked processed`,
          );
      }
    });
  }

  private async onStudentCreated(
    envelope: OutboxEnvelope,
    // Prisma's tx type — we use $executeRawUnsafe and the model accessor
    // identically to the production tx.
    tx: Parameters<Parameters<PrismaService['withTenant']>[1]>[0],
  ): Promise<void> {
    const studentId = (envelope.payload as { studentId?: string }).studentId;
    if (!studentId || !UUID_RE.test(studentId)) {
      throw new Error(
        `student.created event missing/invalid studentId: ${envelope.id}`,
      );
    }
    await tx.enrollmentSlot.create({
      data: {
        tenantId: envelope.tenantId,
        studentId,
        status: 'pending',
      },
    });
    this.logger.log(
      `enrollment_slot created for student ${studentId} (tenant ${envelope.tenantId})`,
    );
  }
}
