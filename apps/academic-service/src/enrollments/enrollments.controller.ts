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
import { JwtAuthGuard, SmsJwtPayload } from '../auth/jwt-auth.guard';
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
@UseGuards(JwtAuthGuard)
export class EnrollmentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  async confirm(
    @Body() body: ConfirmEnrollmentDto,
    @Req() req: { user: SmsJwtPayload },
  ): Promise<{ id: string; status: string }> {
    const tenantId = req.user.tenantId;
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
    @Req() req: { user: SmsJwtPayload },
  ): Promise<void> {
    const tenantId = req.user.tenantId;
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
