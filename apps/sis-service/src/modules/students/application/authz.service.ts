import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  STUDENT_REPOSITORY,
  StudentRepository,
} from '../domain/repositories/student.repository';

interface PrincipalRolesView {
  roles: readonly string[];
  userId: string | null;
}

/**
 * Application-layer ABAC for the parent-of-student-X policy.
 *
 * Defense in depth (with the SECURITY DEFINER + Student RLS policy
 * from migration 20260510130000_parent_abac_rls):
 *
 *   - RLS is the floor: every Student SELECT goes through the policy.
 *     A parent's tx sees ONLY students they're a guardian of.
 *
 *   - This service is the second layer: explicit "can this principal
 *     access this resource?" check, callable from use cases that need
 *     a clear 403 instead of a silent empty result.
 *
 * Why both?
 *   - RLS gives back "no rows" — looks identical to "doesn't exist."
 *     For a 403 vs 404 distinction at the API layer, we need to know
 *     ahead of time whether access would be denied.
 *   - A future use case that uses raw SQL (rare but possible) bypasses
 *     RLS only if it runs as sms_app. For app_user, RLS still applies.
 *     The app-layer check is the audit-log surface for denials.
 *
 * Role taxonomy mapped to the data model:
 *   district-admin / school-admin / teacher → "see all of tenant's
 *     students" (rely on tenant_isolation; no parent-of filter applies)
 *   parent → see only students they're linked to via guardian_link
 *   student → see only themselves (out of scope today; Phase 1.7 BFF)
 */
@Injectable()
export class AuthzService {
  constructor(
    private readonly cls: ClsService,
    private readonly prisma: PrismaService,
    @Inject(STUDENT_REPOSITORY) private readonly students: StudentRepository,
  ) {}

  private currentPrincipal(): PrincipalRolesView {
    return {
      roles: this.cls.get<string[]>('roles') ?? [],
      userId: this.cls.get<string>('userId') ?? null,
    };
  }

  /**
   * Returns silently when access is allowed. Throws 403 when forbidden.
   *
   * Resolution order:
   *   1. Admin/teacher roles → allowed (RLS handles tenant scope).
   *   2. Parent role → check guardian_link via the SECURITY DEFINER
   *      function. RLS would also reject the read; we run the check
   *      explicitly so the API returns 403 (not 404) on real-but-not-
   *      visible students.
   *   3. Else (no recognized role) → forbidden.
   */
  async assertCanAccessStudent(studentId: string): Promise<void> {
    const principal = this.currentPrincipal();
    if (this.hasAny(principal.roles, ['district-admin', 'school-admin', 'teacher'])) {
      return;
    }
    if (this.hasAny(principal.roles, ['parent'])) {
      if (!principal.userId) {
        throw new ForbiddenException(
          'parent access requires authenticated user context',
        );
      }
      const allowed = await this.checkGuardianLink(studentId, principal.userId);
      if (!allowed) {
        throw new ForbiddenException(
          `not a guardian of student ${studentId}`,
        );
      }
      return;
    }
    throw new ForbiddenException('no role permits this action');
  }

  private hasAny(roles: readonly string[], required: string[]): boolean {
    return required.some((r) => roles.includes(r));
  }

  private async checkGuardianLink(
    studentId: string,
    userId: string,
  ): Promise<boolean> {
    // Run the SECURITY DEFINER function via raw SQL. We DON'T need a
    // tenant context for this lookup — the function bypasses RLS
    // intentionally — but the calling controller is already inside
    // withTenant, so the GUC is set anyway.
    const rows = await this.prisma.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT app.is_guardian_of($1::uuid, $2::uuid) AS ok`,
      studentId,
      userId,
    );
    return rows[0]?.ok === true;
  }
}
