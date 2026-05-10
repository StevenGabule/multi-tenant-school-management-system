/**
 * Generic saga primitives.
 *
 * A saga is a list of steps. Each step has:
 *   • a name (stable identifier for logs, traces, idempotency keys)
 *   • execute(ctx) — the forward action; throws on failure
 *   • compensate(ctx, output) — the reversal; MUST be idempotent and
 *     MUST handle "the thing I'm undoing might not exist or might be
 *     partially created" without throwing
 *
 * The executor is generic over the saga TYPE; sagas don't know about
 * the executor. This boundary is what lets us swap the polling executor
 * for Temporal/BullMQ later (ADR-0012) — the saga *definitions* don't
 * change.
 *
 * NOT included here (intentional Phase 1.5 limits):
 *   • parallel step DAGs — list-of-steps is the simplest shape that
 *     teaches the pattern; DAG support is in milestone 1.5+ as needed
 *   • per-step timeouts — the retry budget bounds cost today; Phase 2
 *     adds wall-clock deadlines
 *   • scheduled compensations — a step that needs to schedule "delete
 *     this in 24h" is out of scope; that's a domain concern (TTL on the
 *     row), not a saga primitive
 */

/**
 * The execution context passed to each step. Composed at executor time
 * from the saga's persisted payload (input + accumulated step outputs)
 * plus the runtime tenantId/sagaId.
 *
 * Type-erased at this layer; per-saga step definitions narrow `input`
 * and `steps` via TypeScript generics in the concrete EnrollmentSaga.
 */
export interface SagaContext<TInput = Record<string, unknown>> {
  readonly sagaId: string;
  readonly tenantId: string;
  readonly input: TInput;
  /**
   * Outputs of previously-completed steps, keyed by step name. Populated
   * incrementally as the executor walks forward. Only completed steps
   * are present — a failed/in-flight step has no entry.
   */
  readonly steps: Readonly<Record<string, unknown>>;
}

export interface StepDefinition<
  TInput = Record<string, unknown>,
  TOutput = unknown,
> {
  /** Stable identifier. Used in logs, traces, idempotency keys. */
  readonly name: string;
  /**
   * The forward action. Throws to signal failure (which the executor
   * counts toward the retry budget). Returns the captured output, which
   * the executor persists onto the corresponding saga_step row.
   */
  execute(ctx: SagaContext<TInput>): Promise<TOutput>;
  /**
   * The reversal. Receives the step's own captured output. MUST be
   * idempotent and tolerant of partial completion (the step may have
   * crashed mid-execution).
   *
   * If `output` is null, the step never reached "completed" — handle
   * that case by no-oping or by best-effort cleanup of any side effects
   * the step might have started.
   */
  compensate(
    ctx: SagaContext<TInput>,
    output: TOutput | null,
  ): Promise<void>;
}

export interface SagaDefinition<TInput = Record<string, unknown>> {
  /** "enrollment", future "tenant-promotion", etc. */
  readonly type: string;
  readonly steps: readonly StepDefinition<TInput, unknown>[];
}

/**
 * The retry budget per step. After this many attempts of execute(), the
 * executor transitions the saga to compensating.
 *
 * Three is a deliberate compromise: enough to absorb transient blips
 * (network hiccup, brief downstream contention) but not so many that a
 * persistently-broken step blocks resources for hours.
 */
export const STEP_RETRY_BUDGET = 3;
