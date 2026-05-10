import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, PoolClient } from 'pg';
import { EnrollmentSaga, EnrollmentInput } from './enrollment.saga';
import {
  SagaContext,
  SagaDefinition,
  STEP_RETRY_BUDGET,
  StepDefinition,
} from './saga-definition';

interface SagaInstanceRow {
  id: string;
  tenantId: string;
  type: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  payload: { input: EnrollmentInput; steps: Record<string, unknown> };
  retryCount: number;
}

interface SagaStepRow {
  id: string;
  stepIndex: number;
  name: string;
  status: string;
  attempts: number;
  output: unknown;
}

/**
 * The saga executor. The heart of milestone 1.5.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  every 1s tick:                                            │
 *   │    1. claim ONE saga via FOR UPDATE SKIP LOCKED            │
 *   │       (multi-replica safe — different rows, no contention) │
 *   │    2. dispatch by status:                                  │
 *   │         running       → run-next-pending-step              │
 *   │         compensating  → compensate-next-completed-step     │
 *   │    3. step result updates saga + step state in same tx     │
 *   │    4. commit (releases lock)                               │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Key design decisions (with rationale):
 *
 *   • One-saga-per-tick. Simpler than batching; throughput is bounded
 *     by the tick interval × replica count, which is fine for Phase 1.
 *     Phase 2 can switch to a queue or BullMQ if throughput matters
 *     (graduation triggers in ADR-0012).
 *
 *   • The saga's tx STAYS OPEN through the cross-service HTTP call.
 *     Holds the row lock for the duration of the step. Cost: long-held
 *     locks reduce parallelism. Benefit: simpler recovery — if the
 *     executor crashes mid-step, the tx aborts cleanly and the next
 *     tick re-claims the saga in its prior state. Trades throughput
 *     for correctness clarity in Phase 1.
 *
 *   • Compensation walks BACKWARDS from the highest completed step.
 *     The walk is one-step-per-tick (same as forward execution) so the
 *     control flow is symmetrical and idempotent under crashes.
 *
 *   • Connects as sms_app (BYPASSRLS) so it can scan ALL tenants'
 *     sagas. Same pattern as the outbox relay. Bypasses PgBouncer
 *     because long FOR UPDATE SKIP LOCKED transactions don't play
 *     nicely with transaction-mode pooling.
 */
@Injectable()
export class SagaExecutor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SagaExecutor.name);
  private client: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly tickIntervalMs = 1_000;
  private readonly definitions: Map<string, SagaDefinition<unknown>>;

  constructor(
    private readonly config: ConfigService,
    enrollmentSaga: EnrollmentSaga,
  ) {
    this.definitions = new Map([
      [enrollmentSaga.type, enrollmentSaga as SagaDefinition<unknown>],
    ]);
  }

  async onModuleInit(): Promise<void> {
    this.client = new Client({
      connectionString: this.config.getOrThrow<string>(
        'ENROLLMENT_EXECUTOR_URL',
      ),
    });
    await this.client.connect();
    this.logger.log('saga executor started');
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.client) {
      await this.client.end().catch(() => undefined);
      this.client = null;
    }
    this.logger.log('saga executor stopped');
  }

  /** Process at most one saga; return whether work was done. Exposed for tests. */
  async tick(): Promise<boolean> {
    if (!this.client) return false;
    if (this.ticking) return false;
    this.ticking = true;
    try {
      const c = this.client;
      await c.query('BEGIN');
      const claim = await c.query<SagaInstanceRow>(
        `SELECT id, "tenantId", type, status, "currentStep", "totalSteps",
                payload, "retryCount"
           FROM saga_instance
          WHERE status IN ('running', 'compensating')
          ORDER BY "startedAt"
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (claim.rowCount === 0) {
        await c.query('ROLLBACK');
        return false;
      }
      const saga = claim.rows[0];
      const def = this.definitions.get(saga.type);
      if (!def) {
        // Unknown saga type — possibly a deploy where the executor is
        // older than the saga definition. Mark failed (rather than
        // looping forever) and log loudly.
        await c.query(
          `UPDATE saga_instance
              SET status='failed', "lastError" = $1::jsonb, "completedAt"=NOW()
            WHERE id = $2`,
          [JSON.stringify({ reason: `unknown saga type: ${saga.type}` }), saga.id],
        );
        await c.query('COMMIT');
        this.logger.error(`unknown saga type ${saga.type} for saga ${saga.id}`);
        return true;
      }

      if (saga.status === 'running') {
        await this.advanceForward(c, saga, def);
      } else if (saga.status === 'compensating') {
        await this.advanceBackward(c, saga, def);
      }
      await c.query('COMMIT');
      return true;
    } catch (err) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        /* swallow */
      }
      this.logger.error(
        `tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      this.ticking = false;
    }
  }

  private async advanceForward(
    c: Client | PoolClient,
    saga: SagaInstanceRow,
    def: SagaDefinition<unknown>,
  ): Promise<void> {
    const stepDef = def.steps[saga.currentStep];
    if (!stepDef) {
      // Past the last step — saga is complete.
      await c.query(
        `UPDATE saga_instance SET status='completed', "completedAt"=NOW() WHERE id=$1`,
        [saga.id],
      );
      this.logger.log(`saga ${saga.id} completed`);
      return;
    }
    // Ensure a saga_step row exists for this index. The controller seeds
    // all rows up-front (Step 5), but defensive UPSERT keeps the executor
    // robust to schema drift.
    await c.query(
      `INSERT INTO saga_step (id, "sagaId", "stepIndex", "name", "status", "attempts")
       VALUES (gen_random_uuid(), $1, $2, $3, 'pending', 0)
       ON CONFLICT ("sagaId", "stepIndex") DO NOTHING`,
      [saga.id, saga.currentStep, stepDef.name],
    );

    const stepRow = await this.fetchStep(c, saga.id, saga.currentStep);
    if (stepRow.status === 'completed') {
      // Already completed (post-recovery edge case). Advance.
      await this.advanceCurrentStep(c, saga);
      return;
    }

    await c.query(
      `UPDATE saga_step SET status='running', "startedAt"=NOW(), attempts=attempts+1
        WHERE "sagaId"=$1 AND "stepIndex"=$2`,
      [saga.id, saga.currentStep],
    );
    const ctx = this.buildContext(saga, def);
    try {
      const output = await stepDef.execute(ctx);
      await c.query(
        `UPDATE saga_step
            SET status='completed', output=$1::jsonb, "completedAt"=NOW(), error=NULL
          WHERE "sagaId"=$2 AND "stepIndex"=$3`,
        [JSON.stringify(output ?? null), saga.id, saga.currentStep],
      );
      // Capture output into payload.steps[name] so subsequent steps can read it.
      const updatedSteps = {
        ...saga.payload.steps,
        [stepDef.name]: output,
      };
      await c.query(
        `UPDATE saga_instance
            SET payload = jsonb_set(payload, '{steps}', $1::jsonb),
                "currentStep" = "currentStep" + 1,
                "retryCount" = 0,
                "lastError" = NULL
          WHERE id = $2`,
        [JSON.stringify(updatedSteps), saga.id],
      );
      // If we just completed the last step, mark saga completed.
      if (saga.currentStep + 1 >= saga.totalSteps) {
        await c.query(
          `UPDATE saga_instance SET status='completed', "completedAt"=NOW() WHERE id=$1`,
          [saga.id],
        );
        this.logger.log(`saga ${saga.id} completed`);
      } else {
        this.logger.log(
          `saga ${saga.id} step ${stepDef.name} completed; advancing to step ${saga.currentStep + 1}`,
        );
      }
    } catch (err) {
      const errPayload = serializeError(err);
      const newAttempts = stepRow.attempts + 1;
      if (newAttempts >= STEP_RETRY_BUDGET) {
        // Retry budget exhausted — transition to compensating. The
        // current step is marked failed; future ticks will compensate
        // the previously-completed steps in reverse.
        await c.query(
          `UPDATE saga_step SET status='failed', error=$1::jsonb
            WHERE "sagaId"=$2 AND "stepIndex"=$3`,
          [JSON.stringify(errPayload), saga.id, saga.currentStep],
        );
        await c.query(
          `UPDATE saga_instance
              SET status='compensating', "lastError"=$1::jsonb
            WHERE id=$2`,
          [JSON.stringify(errPayload), saga.id],
        );
        this.logger.warn(
          `saga ${saga.id} step ${stepDef.name} exhausted retries; compensating`,
        );
      } else {
        // Transient failure — log + leave the step in 'running' (the
        // attempts column has been incremented). Next tick will retry.
        await c.query(
          `UPDATE saga_step SET status='pending', error=$1::jsonb
            WHERE "sagaId"=$2 AND "stepIndex"=$3`,
          [JSON.stringify(errPayload), saga.id, saga.currentStep],
        );
        await c.query(
          `UPDATE saga_instance
              SET "retryCount" = "retryCount" + 1, "lastError" = $1::jsonb
            WHERE id = $2`,
          [JSON.stringify(errPayload), saga.id],
        );
        this.logger.warn(
          `saga ${saga.id} step ${stepDef.name} attempt ${newAttempts}/${STEP_RETRY_BUDGET} failed: ${errPayload.message}`,
        );
      }
    }
  }

  private async advanceBackward(
    c: Client | PoolClient,
    saga: SagaInstanceRow,
    def: SagaDefinition<unknown>,
  ): Promise<void> {
    // Find the highest stepIndex with status='completed' that hasn't
    // been compensated yet. We compensate one step per tick.
    const target = await c.query<SagaStepRow>(
      `SELECT id, "stepIndex", "name", status, attempts, output
         FROM saga_step
        WHERE "sagaId" = $1 AND status = 'completed'
        ORDER BY "stepIndex" DESC
        LIMIT 1`,
      [saga.id],
    );
    if (target.rowCount === 0) {
      // All completed steps compensated — saga is fully reversed.
      await c.query(
        `UPDATE saga_instance
            SET status='compensated', "completedAt"=NOW()
          WHERE id=$1`,
        [saga.id],
      );
      this.logger.log(`saga ${saga.id} compensated`);
      return;
    }
    const stepRow = target.rows[0];
    const stepDef = def.steps[stepRow.stepIndex];
    if (!stepDef) {
      // Definition out-of-sync; can't compensate. Saga goes to failed.
      await c.query(
        `UPDATE saga_instance
            SET status='failed',
                "lastError" = $1::jsonb,
                "completedAt"=NOW()
          WHERE id=$2`,
        [
          JSON.stringify({
            reason: `no step definition for index ${stepRow.stepIndex}`,
          }),
          saga.id,
        ],
      );
      this.logger.error(
        `saga ${saga.id}: missing step def for index ${stepRow.stepIndex}; marking failed`,
      );
      return;
    }

    const ctx = this.buildContext(saga, def);
    try {
      await stepDef.compensate(ctx, stepRow.output);
      await c.query(
        `UPDATE saga_step SET status='compensated', "compensatedAt"=NOW()
          WHERE id=$1`,
        [stepRow.id],
      );
      this.logger.log(
        `saga ${saga.id} step ${stepDef.name} compensated`,
      );
    } catch (err) {
      const errPayload = serializeError(err);
      // A compensation failure is the worst case. We transition the
      // saga to 'failed' (manual intervention) rather than retrying
      // forever. The step row keeps status='completed' (the original
      // forward action did succeed) plus the compensation error.
      await c.query(
        `UPDATE saga_step SET error=$1::jsonb WHERE id=$2`,
        [JSON.stringify(errPayload), stepRow.id],
      );
      await c.query(
        `UPDATE saga_instance
            SET status='failed',
                "lastError" = $1::jsonb,
                "completedAt"=NOW()
          WHERE id=$2`,
        [
          JSON.stringify({
            reason: 'compensation failed',
            stepName: stepDef.name,
            stepIndex: stepRow.stepIndex,
            ...errPayload,
          }),
          saga.id,
        ],
      );
      this.logger.error(
        `saga ${saga.id} compensation of ${stepDef.name} FAILED — manual intervention required: ${errPayload.message}`,
      );
    }
  }

  private async fetchStep(
    c: Client | PoolClient,
    sagaId: string,
    stepIndex: number,
  ): Promise<SagaStepRow> {
    const r = await c.query<SagaStepRow>(
      `SELECT id, "stepIndex", "name", status, attempts, output
         FROM saga_step
        WHERE "sagaId"=$1 AND "stepIndex"=$2`,
      [sagaId, stepIndex],
    );
    return r.rows[0];
  }

  private async advanceCurrentStep(
    c: Client | PoolClient,
    saga: SagaInstanceRow,
  ): Promise<void> {
    await c.query(
      `UPDATE saga_instance SET "currentStep"="currentStep"+1, "retryCount"=0
        WHERE id=$1`,
      [saga.id],
    );
  }

  private buildContext(
    saga: SagaInstanceRow,
    def: SagaDefinition<unknown>,
  ): SagaContext<unknown> {
    // For the EnrollmentSaga we'd ideally call def.buildContext, but the
    // SagaDefinition interface doesn't require it — keeps the executor
    // generic. Construct directly from the saga row.
    return {
      sagaId: saga.id,
      tenantId: saga.tenantId,
      input: saga.payload.input,
      steps: saga.payload.steps ?? {},
    };
  }

  private scheduleNext(): void {
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        this.logger.error(
          `tick threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (this.client) this.scheduleNext();
    }, this.tickIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}

interface SerializedError {
  message: string;
  name: string;
  status?: number;
  stack?: string;
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      status: (err as Error & { status?: number }).status,
    };
  }
  return { name: 'unknown', message: String(err) };
}
