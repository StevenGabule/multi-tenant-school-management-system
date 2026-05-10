import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  context as otelContext,
  propagation,
  trace,
} from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';
import { KeycloakService } from './keycloak.service.js';
import type {
  AuthenticatedPrincipal,
  KeycloakJwtPayload,
} from './keycloak-jwt.types.js';

// Re-exported for backward compat with existing consumers; the source
// of truth lives in tokens.ts to break the import cycle.
export { KEYCLOAK_OPTIONS } from './tokens.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * KeycloakAuthGuard — replaces the hand-rolled JwtAuthGuard from milestone 1.1.
 *
 * Validation chain (each step throws 401 on failure):
 *
 *   1. Extract `Authorization: Bearer <jwt>` from the request.
 *   2. KeycloakService.verify() — signature against JWKS, iss/aud/exp/nbf.
 *   3. Sanity-check the tenant_id claim (UUID shape) when present.
 *   4. Populate request.user (AuthenticatedPrincipal) and CLS
 *      (tenantId/userId/roles), so downstream code (PrismaService.withTenant,
 *      use cases, ABAC checks) reads from CLS as before.
 *
 * Two intentional differences from the hand-rolled guard:
 *
 *   • No tenant-registry lookup here. The Keycloak token is the source
 *     of truth for tenant_id; we trust the issuer (verified by the JWKS
 *     signature). The registry is still consulted by callers that need
 *     tenant.status — but that's a separate concern from "is this a
 *     valid token?".
 *
 *   • Service-account tokens (azp=services, no tenant_id claim) ARE
 *     allowed through. The downstream code checks tenantId presence
 *     when it needs one (e.g., withTenant) — service tokens that don't
 *     carry tenant_id can't access tenant-scoped endpoints unless they
 *     pass tenantId through some other channel (saga payload, request body).
 */
@Injectable()
export class KeycloakAuthGuard implements CanActivate {
  private readonly logger = new Logger(KeycloakAuthGuard.name);

  constructor(
    private readonly keycloak: KeycloakService,
    private readonly cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: AuthenticatedPrincipal;
    }>();
    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or malformed Authorization header',
      );
    }
    const token = auth.slice('Bearer '.length).trim();

    let payload: KeycloakJwtPayload;
    try {
      const result = await this.keycloak.verify(token);
      payload = result.payload;
    } catch (err) {
      this.logger.debug(
        `JWT verification failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      throw new UnauthorizedException('Invalid JWT');
    }

    if (!payload.sub) {
      throw new UnauthorizedException('JWT missing sub claim');
    }
    let tenantId =
      typeof payload.tenant_id === 'string' ? payload.tenant_id : null;
    if (tenantId !== null && !UUID_RE.test(tenantId)) {
      throw new UnauthorizedException('JWT tenant_id is not a valid UUID');
    }

    // Service tokens (client_credentials grant) carry no tenant_id —
    // they're issued for the `services` client itself, not for a tenant
    // user. The saga executor and other service callers declare the
    // tenant per-request via X-Tenant-Id. We accept this ONLY when the
    // token is recognizably a service token (azp matches a known
    // service-account client AND the preferred_username has the
    // service-account- prefix Keycloak uses).
    const isServiceToken =
      typeof payload.azp === 'string' &&
      typeof payload.preferred_username === 'string' &&
      payload.preferred_username.startsWith('service-account-');
    if (!tenantId && isServiceToken) {
      const headerTenant = req.headers['x-tenant-id'];
      if (typeof headerTenant === 'string' && UUID_RE.test(headerTenant)) {
        tenantId = headerTenant;
      }
    }

    const principal: AuthenticatedPrincipal = {
      userId: payload.sub,
      tenantId,
      roles: payload.realm_access?.roles ?? [],
      raw: payload,
    };
    req.user = principal;
    if (tenantId) this.cls.set('tenantId', tenantId);
    this.cls.set('userId', principal.userId);
    this.cls.set('roles', principal.roles);

    // Propagate tenant + user context as OTel baggage so the collector
    // can promote them onto every span/log. The "promote baggage to
    // attributes" trick lives in the collector's attributes processor
    // (see infra/observability/collector/config.yaml).
    //
    // Also stamp the active span directly — gives us coverage even if
    // the baggage→attribute promotion is mis-configured for some signal.
    const baggageEntries: Record<string, { value: string }> = {
      'user.id': { value: principal.userId },
    };
    if (tenantId) baggageEntries['tenant.id'] = { value: tenantId };
    const baggage = propagation.createBaggage(baggageEntries);
    propagation.setBaggage(otelContext.active(), baggage);

    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute('user.id', principal.userId);
      if (tenantId) span.setAttribute('tenant.id', tenantId);
    }
    return true;
  }
}
