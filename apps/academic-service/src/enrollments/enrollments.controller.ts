import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthenticatedPrincipal, KeycloakAuthGuard } from '@org/auth-keycloak';
import { BadRequestException } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { ConfirmEnrollmentDto } from './enrollments.dtos';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  /**
   * List enrollments for the current tenant. Supports filtering by
   * studentId(s) — the BFF uses this to enrich the parent dashboard
   * with each child's confirmed enrollments.
   *
   * `studentIds` is a comma-separated list of UUIDs (Express's default
   * query parser treats `?studentIds=a&studentIds=b` as an array, but
   * the comma form is friendlier in tests/curl). Empty filter returns
   * the full tenant list; RLS scopes it.
   *
   * Authorization: KeycloakAuthGuard validates the JWT. RLS enforces
   * tenant isolation at the DB. We do NOT add an ABAC check here for
   * "is the caller a guardian of these students?" — that's the BFF's
   * job (it derives the studentIds from the parent's authenticated
   * children, not from caller-controlled query params).
   */
  @Get()
  async list(
    @Query('studentIds') studentIds: string | undefined,
    @Req() req: { user: AuthenticatedPrincipal },
  ): Promise<
    Array<{
      id: string;
      studentId: string;
      classId: string;
      status: string;
      createdAt: Date;
    }>
  > {
    const tenantId = requireTenant(req.user);
    const ids = parseStudentIds(studentIds);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.enrollment.findMany({
        where: ids.length > 0 ? { studentId: { in: ids } } : undefined,
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => ({
        id: r.id,
        studentId: r.studentId,
        classId: r.classId,
        status: r.status,
        createdAt: r.createdAt,
      }));
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

/**
 * Parse `?studentIds=a,b,c` (or `?studentIds=a&studentIds=b`) into a
 * deduplicated UUID array. Rejects malformed UUIDs with 400 — defense
 * against accidental SQL-shaped strings reaching the DB layer.
 */
function parseStudentIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const t of tokens) {
    if (!UUID_RE.test(t)) {
      throw new BadRequestException(
        `studentIds contains a non-UUID value: "${t}"`,
      );
    }
  }
  return Array.from(new Set(tokens));
}
