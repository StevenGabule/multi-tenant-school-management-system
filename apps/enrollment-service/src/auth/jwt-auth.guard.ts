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

// Identical contract to sis-service's guard. Will be deduplicated in 1.6.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SmsJwtPayload {
  sub: string;
  tenantId: string;
  roles?: string[];
  iat?: number;
  exp?: number;
}

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
      this.logger.debug(
        `JWT verification failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      throw new UnauthorizedException('Invalid JWT');
    }

    if (!payload.tenantId || !UUID_RE.test(payload.tenantId)) {
      throw new UnauthorizedException('JWT missing valid tenantId claim');
    }
    if (!payload.sub) {
      throw new UnauthorizedException('JWT missing sub claim');
    }

    let tenant: Tenant | null;
    try {
      tenant = await this.registry.findById(payload.tenantId);
    } catch (err) {
      if (err instanceof TenantRegistryUnavailableError) {
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
