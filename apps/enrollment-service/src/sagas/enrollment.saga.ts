import { Injectable } from '@nestjs/common';
import { CrossServiceClient } from './cross-service.client';
import { SagaContext, SagaDefinition, StepDefinition } from './saga-definition';

/**
 * The Enrollment saga.
 *
 *   1. create-student      → SIS creates a Student (writes Student row +
 *                            outbox event in one tx)
 *   2. confirm-enrollment  → academic-service creates a confirmed
 *                            Enrollment row pointing the student at a class
 *
 * Compensation order (reverse): if step 2 fails its retry budget, run
 * compensate(step 1) — soft-delete the student. If step 2 succeeded
 * but step N+1 fails (no such step today; placeholder for a 3-step
 * version with notification), we'd compensate step 2 then step 1.
 *
 * Idempotency keys on cross-service calls use `<sagaId>:<stepIndex>`.
 * That key is stable across retries of the same step but UNIQUE per
 * saga, so a saga that re-runs (e.g., compensated then manually replayed)
 * gets a fresh slate.
 *
 * NOT included here (deliberately, for milestone 1.5 scope):
 *   • a third "send-welcome-notification" step. Showing the no-op
 *     compensation pattern requires a notification service we don't
 *     have yet; the *pattern* is documented in ADR-0011 and in the
 *     compensate function below as a comment, but not yet exercised.
 */
export interface EnrollmentInput {
  studentInfo: {
    firstName: string;
    middleName?: string;
    lastName: string;
    dateOfBirth: string;
    email?: string;
    phone?: string;
    gender?: string;
    externalId?: string;
  };
  classId: string;
  parentEmail?: string;
}

export interface CreateStudentOutput {
  studentId: string;
  externalId: string | null;
}

export interface ConfirmEnrollmentOutput {
  enrollmentId: string;
}

@Injectable()
export class EnrollmentSaga implements SagaDefinition<EnrollmentInput> {
  readonly type = 'enrollment';
  readonly steps: readonly StepDefinition<EnrollmentInput, unknown>[];

  constructor(private readonly client: CrossServiceClient) {
    this.steps = [this.createStudentStep(), this.confirmEnrollmentStep()];
  }

  private createStudentStep(): StepDefinition<
    EnrollmentInput,
    CreateStudentOutput
  > {
    return {
      name: 'create-student',
      execute: async (ctx) => {
        const { id, externalId } = await this.client.createStudent({
          tenantId: ctx.tenantId,
          idempotencyKey: idempKey(ctx.sagaId, 0),
          body: ctx.input.studentInfo,
        });
        return { studentId: id, externalId };
      },
      compensate: async (ctx, output) => {
        if (!output?.studentId) {
          // Step never produced a studentId → never created a student
          // (or crashed before capture). Nothing to undo.
          return;
        }
        await this.client.softDeleteStudent({
          tenantId: ctx.tenantId,
          idempotencyKey: `${idempKey(ctx.sagaId, 0)}:compensate`,
          studentId: output.studentId,
        });
      },
    };
  }

  private confirmEnrollmentStep(): StepDefinition<
    EnrollmentInput,
    ConfirmEnrollmentOutput
  > {
    return {
      name: 'confirm-enrollment',
      execute: async (ctx) => {
        const prior = ctx.steps['create-student'] as
          | CreateStudentOutput
          | undefined;
        if (!prior?.studentId) {
          throw new Error(
            'confirm-enrollment requires a successful create-student',
          );
        }
        const { id } = await this.client.confirmEnrollment({
          tenantId: ctx.tenantId,
          idempotencyKey: idempKey(ctx.sagaId, 1),
          body: { studentId: prior.studentId, classId: ctx.input.classId },
        });
        return { enrollmentId: id };
      },
      compensate: async (ctx, output) => {
        if (!output?.enrollmentId) return;
        await this.client.cancelEnrollment({
          tenantId: ctx.tenantId,
          idempotencyKey: `${idempKey(ctx.sagaId, 1)}:compensate`,
          enrollmentId: output.enrollmentId,
        });
      },
    };
  }

  /**
   * Build the full SagaContext from a persisted payload. The executor
   * calls this between fetching the saga row and invoking a step —
   * keeps the executor type-clean and the payload-shape policy in one
   * place.
   */
  buildContext(args: {
    sagaId: string;
    tenantId: string;
    payload: { input: EnrollmentInput; steps: Record<string, unknown> };
  }): SagaContext<EnrollmentInput> {
    return {
      sagaId: args.sagaId,
      tenantId: args.tenantId,
      input: args.payload.input,
      steps: args.payload.steps ?? {},
    };
  }
}

function idempKey(sagaId: string, stepIndex: number): string {
  return `${sagaId}:${stepIndex}`;
}
