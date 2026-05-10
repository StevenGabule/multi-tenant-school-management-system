import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedPrincipal, KeycloakAuthGuard } from '@org/auth-keycloak';
import { PrismaService } from '../prisma/prisma.service';
import { EnrollmentSaga } from '../sagas/enrollment.saga';
import { StartEnrollmentDto } from './enrollments.dtos';

interface StepView {
  stepIndex: number;
  name: string;
  status: string;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  compensatedAt: Date | null;
  error: unknown;
}

interface EnrollmentView {
  id: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  startedAt: Date;
  completedAt: Date | null;
  lastError: unknown;
  steps: StepView[];
}

/**
 * The enrollment HTTP surface.
 *
 *   POST /api/enrollments
 *     → 202 Accepted
 *       Saga is created with status='running'; the executor will pick
 *       it up on its next tick. Response is intentionally async — the
 *       contract is "we'll do it eventually," not "it's done."
 *
 *   GET /api/enrollments/:id
 *     → operator surface; returns full per-step state. This is what an
 *       admin or oncall engineer reaches for first when a saga is wedged.
 *
 * Tenant isolation: KeycloakAuthGuard puts tenantId in CLS; withTenant
 * sets the GUC for the transaction. Cross-tenant reads are blocked by RLS.
 */
@Controller('enrollments')
@UseGuards(KeycloakAuthGuard)
export class EnrollmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollmentSaga: EnrollmentSaga,
  ) {}

  @Post()
  @HttpCode(202)
  async start(
    @Body() body: StartEnrollmentDto,
    @Req() req: { user: AuthenticatedPrincipal },
  ): Promise<{
    id: string;
    status: string;
    currentStep: number;
    totalSteps: number;
  }> {
    const tenantId = requireTenant(req.user);
    const totalSteps = this.enrollmentSaga.steps.length;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const saga = await tx.sagaInstance.create({
        data: {
          tenantId,
          type: this.enrollmentSaga.type,
          status: 'running',
          currentStep: 0,
          totalSteps,
          payload: { input: body, steps: {} },
        },
      });
      // Seed all step rows up-front. The executor's INSERT ... ON
      // CONFLICT is defensive but normally no-ops because the rows
      // already exist.
      for (let i = 0; i < totalSteps; i++) {
        await tx.sagaStep.create({
          data: {
            sagaId: saga.id,
            stepIndex: i,
            name: this.enrollmentSaga.steps[i].name,
            status: 'pending',
          },
        });
      }
      return {
        id: saga.id,
        status: saga.status,
        currentStep: saga.currentStep,
        totalSteps,
      };
    });
  }

  @Get(':id')
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: { user: AuthenticatedPrincipal },
  ): Promise<EnrollmentView> {
    const tenantId = requireTenant(req.user);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const saga = await tx.sagaInstance.findUnique({
        where: { id },
        include: {
          steps: { orderBy: { stepIndex: 'asc' } },
        },
      });
      if (!saga) {
        // RLS makes a cross-tenant saga look like a missing one. Same
        // 404, no info leak.
        throw new NotFoundException(`saga ${id} not found`);
      }
      return {
        id: saga.id,
        status: saga.status,
        currentStep: saga.currentStep,
        totalSteps: saga.totalSteps,
        startedAt: saga.startedAt,
        completedAt: saga.completedAt,
        lastError: saga.lastError,
        steps: saga.steps.map((s) => ({
          stepIndex: s.stepIndex,
          name: s.name,
          status: s.status,
          attempts: s.attempts,
          startedAt: s.startedAt,
          completedAt: s.completedAt,
          compensatedAt: s.compensatedAt,
          error: s.error,
        })),
      };
    });
  }
}

function requireTenant(user: AuthenticatedPrincipal): string {
  if (!user.tenantId) {
    throw new BadRequestException(
      'tenant context required (token has no tenant_id claim)',
    );
  }
  return user.tenantId;
}
