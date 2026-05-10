import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';
import {
  Tenant,
  TenantRegistryService,
  TenantRegistryUnavailableError,
} from '@org/tenant-registry';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SmsJwtPayload {
  sub: string; // user id
  tenantId: string; // tenant uuid
  roles?: string[];
  iat?: number;
  exp?: number;
}

/**
 * Validates a Bearer JWT, resolves the tenant via the registry, and pushes
 * actor + tenant context into CLS.
 *
 * Order of fail-closed checks (each happens before the controller runs):
 *   1. Authorization header well-formed       → 401
 *   2. JWT signature valid                     → 401
 *   3. tenantId/sub claims well-formed         → 401
 *   4. Tenant exists in registry               → 401 (deleted or never existed)
 *   5. Tenant.status is 'active'               → 403 (suspended/terminated/etc.)
 *   6. Registry reachable                      → 503 (fail-closed; ADR-0006)
 *
 * Critical invariant: tenantId comes from the *signature-verified* JWT
 * claim, NEVER from a header. The registry then confirms the tenant
 * actually exists and is active. This double-validation is what makes
 * the multi-tenant guarantee end-to-end:
 *   JWT → tenantId → registry → CLS → SET LOCAL → RLS
 *
 * Milestone 1.6 swaps the hand-rolled JWT verify for Keycloak; the
 * registry resolution stays.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly cls: ClsService,
    private readonly registry: TenantRegistryService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: SmsJwtPayload;
      tenant?: Tenant;
    }>();

    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or malformed Authorization header',
      );
    }
    const token = auth.slice('Bearer '.length).trim();

    let payload: SmsJwtPayload;
    try {
      payload = this.jwt.verify<SmsJwtPayload>(token);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      this.logger.debug(`JWT verification failed: ${reason}`);
      throw new UnauthorizedException('Invalid JWT');
    }

    if (!payload.tenantId || !UUID_RE.test(payload.tenantId)) {
      throw new UnauthorizedException('JWT missing valid tenantId claim');
    }
    if (!payload.sub) {
      throw new UnauthorizedException('JWT missing sub claim');
    }

    // Resolve via registry — confirms the tenant exists AND is active.
    let tenant: Tenant | null;
    try {
      tenant = await this.registry.findById(payload.tenantId);
    } catch (err) {
      if (err instanceof TenantRegistryUnavailableError) {
        // Fail-closed (ADR-0006): we'd rather refuse a valid tenant than
        // serve a suspended one.
        this.logger.error(
          `tenant registry unreachable, refusing request: ${err.message}`,
        );
        throw new ServiceUnavailableException({
          message:
            'tenant registry temporarily unavailable; please retry shortly',
        });
      }
      throw err;
    }

    if (!tenant) {
      // Token is signed correctly but no such tenant exists. Could be a
      // deleted tenant, a token issued for a different environment, or
      // an outright forgery against a stolen secret.
      throw new UnauthorizedException(`unknown tenant: ${payload.tenantId}`);
    }

    if (tenant.status !== 'active') {
      throw new ForbiddenException({
        message: `tenant is ${tenant.status}, requests are not accepted`,
        tenantStatus: tenant.status,
      });
    }

    req.user = payload;
    req.tenant = tenant;
    this.cls.set('tenantId', payload.tenantId);
    this.cls.set('userId', payload.sub);
    this.cls.set('roles', payload.roles ?? []);
    return true;
  }
}
