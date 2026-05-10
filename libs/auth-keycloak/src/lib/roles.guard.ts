import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedPrincipal } from './keycloak-jwt.types.js';

/**
 * Role hierarchy.
 *
 * district-admin implies all the administrative roles below it. Mid-tier
 * and leaf roles are flat. We chose to encode this in code rather than
 * in Keycloak's composite-role feature because:
 *
 *   1. Hierarchy lives next to the guards that consume it; one place to
 *      reason about authorization.
 *   2. Keycloak composite roles work — but require an additional admin-
 *      console click for every tenant we ever onboard, and the implication
 *      isn't visible to engineers reading code.
 *   3. The hierarchy is short and stable (5 roles in Phase 1).
 *
 * If/when this grows past ~20 roles or starts changing per-tenant, we
 * graduate to a policy engine (OPA/Cerbos) — see ADR-0013.
 */
export const ROLE_HIERARCHY: Record<string, readonly string[]> = {
  'district-admin': ['school-admin', 'teacher', 'parent', 'student'],
  'school-admin': ['teacher'],
  teacher: [],
  parent: [],
  student: [],
};

/** Returns true when the user has `required` directly OR via implication. */
export function userHasRole(
  user: Pick<AuthenticatedPrincipal, 'roles'>,
  required: string,
): boolean {
  return user.roles.some(
    (r) => r === required || (ROLE_HIERARCHY[r] ?? []).includes(required),
  );
}

const ROLES_METADATA = 'auth.roles';

/**
 * Decorator: `@Roles('school-admin')` on a controller method requires
 * the caller to be `school-admin` OR a higher role per ROLE_HIERARCHY
 * (so district-admin satisfies the requirement).
 *
 * Multiple roles act as OR — `@Roles('teacher', 'parent')` lets either
 * through.
 */
export const Roles = (...roles: string[]): MethodDecorator =>
  SetMetadata(ROLES_METADATA, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;
    const req = context.switchToHttp().getRequest<{
      user?: AuthenticatedPrincipal;
    }>();
    if (!req.user) {
      // Unauthenticated. The auth guard should have run first; if it
      // didn't and we got here, fail closed.
      throw new ForbiddenException('Not authenticated');
    }
    if (!required.some((role) => userHasRole(req.user!, role))) {
      throw new ForbiddenException(
        `requires one of: ${required.join(', ')}`,
      );
    }
    return true;
  }
}
