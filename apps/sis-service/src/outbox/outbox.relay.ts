import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';

/**
 * OutboxRelay: the polling worker that drains outbox_event into Postgres
 * NOTIFY messages.
 *
 * Design choices (see ADR-0009 + ADR-0010):
 *
 *   • Connects as sms_app (BYPASSRLS) so it can read the outbox across
 *     all tenants. Application code only writes its tenant's rows; the
 *     relay reads everything. Sees ALL outbox rows for ALL tenants.
 *   • Bypasses PgBouncer (direct to Postgres). LISTEN/NOTIFY needs a
 *     long-lived session connection that transaction-mode pooling breaks.
 *   • Polls every 1 second. Each tick:
 *       BEGIN
 *       SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100  ← claim a batch
 *       NOTIFY for each row                          ← queued; sent on COMMIT
 *       UPDATE processedAt = NOW() WHERE id IN (..)  ← mark processed
 *       COMMIT                                       ← atomic
 *     If COMMIT fails, the rows stay unprocessed; next tick retries.
 *     If COMMIT succeeds, the NOTIFY is delivered AND the marker is set
 *     in the same atomic transaction.
 *   • FOR UPDATE SKIP LOCKED means future multiple-replica deployments
 *     don't double-process. Each replica claims a different batch.
 *   • Failure mode: if no consumer is listening at NOTIFY time, that
 *     specific message is lost (LISTEN/NOTIFY is fire-and-forget). The
 *     consumer's processed_events table dedups any retried messages.
 *     Phase 2 with Kafka eliminates this — see ADR-0010.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private client: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly channel: string;
  private readonly batchSize = 100;
  private readonly tickIntervalMs = 1_000;

  constructor(private readonly config: ConfigService) {
    this.channel =
      this.config.get<string>('SIS_OUTBOX_CHANNEL') ?? 'sms.sis.outbox';
  }

  async onModuleInit(): Promise<void> {
    this.client = new Client({
      connectionString: this.config.getOrThrow<string>('SIS_OUTBOX_URL'),
    });
    await this.client.connect();
    this.logger.log(`outbox relay started; channel=${this.channel}`);
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.client) {
      await this.client.end().catch(() => undefined);
      this.client = null;
    }
    this.logger.log('outbox relay stopped');
  }

  /** Drain the outbox once. Returns the number of rows published. */
  async tick(): Promise<number> {
    if (!this.client) return 0;
    if (this.running) return 0; // prevent overlap if a tick runs long
    this.running = true;
    try {
      await this.client.query('BEGIN');
      // Claim a batch atomically. SKIP LOCKED lets future multi-replica
      // deployments parallelize without contention.
      const claimed = await this.client.query(
        `SELECT id, "tenantId", "aggregateId", "aggregateType", "eventType",
                payload, metadata, "occurredAt"
           FROM outbox_event
          WHERE "processedAt" IS NULL
          ORDER BY "occurredAt"
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      if (claimed.rowCount === 0) {
        await this.client.query('ROLLBACK');
        return 0;
      }

      // NOTIFY each event. The payload is the full event row as JSON.
      // pg_notify has an 8000-byte payload limit; small student.created
      // payloads are well under. Future events with large payloads
      // should NOTIFY just the id and have the consumer fetch the row.
      const ids: string[] = [];
      for (const row of claimed.rows) {
        const payload = JSON.stringify({
          id: row.id,
          tenantId: row.tenantId,
          aggregateId: row.aggregateId,
          aggregateType: row.aggregateType,
          eventType: row.eventType,
          payload: row.payload,
          metadata: row.metadata,
          occurredAt: (row.occurredAt as Date).toISOString(),
        });
        // pg_notify(channel, payload) — second arg is text-typed.
        await this.client.query(`SELECT pg_notify($1, $2)`, [
          this.channel,
          payload,
        ]);
        ids.push(row.id);
      }

      // Mark processed in the same tx as the NOTIFY queueing. If COMMIT
      // fails, both the NOTIFY and the marker rollback together.
      await this.client.query(
        `UPDATE outbox_event SET "processedAt" = NOW() WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      await this.client.query('COMMIT');
      this.logger.debug(`relay published ${ids.length} event(s)`);
      return ids.length;
    } catch (err) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        /* swallow */
      }
      this.logger.error(
        `outbox tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.client) this.scheduleNext();
    }, this.tickIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}
