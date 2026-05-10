import {
  Body,
  Controller,
  Delete,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthenticatedPrincipal, KeycloakAuthGuard } from '@org/auth-keycloak';
import { BadRequestException } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { ConfirmEnrollmentDto } from './enrollments.dtos';

/**
 * The synchronous side of academic-service.
 *
 *   POST /api/enrollments  → 201; creates the confirmed Enrollment row
 *   DELETE /api/enrollments/:id → 204; cancels (soft-style) the enrollment
 *
 * Both are idempotent — the IdempotencyInterceptor caches responses by
 * (tenantId, Idempotency-Key). The enrollment saga uses sagaId:stepIndex
 * as the key on POST and sagaId:stepIndex:compensate on DELETE.
 *
 * Distinct from EnrollmentSlot, which the StudentEventsConsumer creates
 * async on student.created. The two unify in a future milestone (course
 * catalog + section assignment); for milestone 1.5 they coexist as
 * separate aggregates.
 */
@Controller('enrollments')
@UseGuards(KeycloakAuthGuard)
export class EnrollmentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async confirm(
    @Body() body: ConfirmEnrollmentDto,
    @Req() req: { user: AuthenticatedPrincipal },
  ): Promise<{ id: string; status: string }> {
    const tenantId = requireTenant(req.user);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.enrollment.create({
        data: {
          tenantId,
          studentId: body.studentId,
          classId: body.classId,
          status: 'confirmed',
        },
      });
      return { id: row.id, status: row.status };
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @UseInterceptors(IdempotencyInterceptor)
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: { user: AuthenticatedPrincipal },
  ): Promise<void> {
    const tenantId = requireTenant(req.user);
    await this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.enrollment.findUnique({ where: { id } });
      if (!row) {
        // Already gone (or never existed for this tenant). 404 from the
        // controller's perspective; the saga catches and treats as ok.
        throw new NotFoundException(`enrollment ${id} not found`);
      }
      // For Phase 1.5 we cancel by deleting. A future milestone may
      // soft-cancel (status='cancelled' + cancelledAt) for audit history.
      await tx.enrollment.delete({ where: { id } });
    });
  }
}

/**
 * Service-account tokens (azp=services) authenticate but don't carry
 * tenant_id — they need to declare the tenant per-request. For now,
 * enrollment endpoints require a tenant, so reject service tokens
 * lacking one. Future milestones may accept tenant in body.
 */
function requireTenant(user: AuthenticatedPrincipal): string {
  if (!user.tenantId) {
    throw new BadRequestException(
      'tenant context required (token has no tenant_id claim)',
    );
  }
  return user.tenantId;
}
