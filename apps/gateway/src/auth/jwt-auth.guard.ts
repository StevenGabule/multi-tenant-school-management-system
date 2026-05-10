import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';

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
 * Validates a Bearer JWT, extracts the tenantId claim, and pushes both
 * the full payload onto `request.user` and `tenantId`/`userId` into CLS.
 *
 * Critical invariant: `tenantId` MUST come from a *signature-verified*
 * JWT claim. Never trust a header. This is the single line of defense
 * that makes RLS load-bearing — RLS looks at app.current_tenant_id, which
 * we set from CLS, which was set from this guard. Break this chain and
 * the multi-tenant guarantee falls.
 *
 * Hand-rolled HS256 here is a milestone-1 stepping stone. Milestone 1.6
 * replaces this with a Keycloak-issued, JWKS-validated token.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly cls: ClsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: SmsJwtPayload;
    }>();

    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
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

    // Fail-closed defaults: any authenticated request without a valid
    // tenantId claim is rejected. This is exactly the bug RLS protects
    // against — but defense in depth catches it earlier.
    if (!payload.tenantId || !UUID_RE.test(payload.tenantId)) {
      throw new UnauthorizedException('JWT missing valid tenantId claim');
    }
    if (!payload.sub) {
      throw new UnauthorizedException('JWT missing sub claim');
    }

    req.user = payload;
    this.cls.set('tenantId', payload.tenantId);
    this.cls.set('userId', payload.sub);
    this.cls.set('roles', payload.roles ?? []);
    return true;
  }
}
