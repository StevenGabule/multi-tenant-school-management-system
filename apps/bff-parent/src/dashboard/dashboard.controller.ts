import {
  Controller,
  Get,
  HttpException,
  Logger,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedPrincipal,
  KeycloakAuthGuard,
} from '@org/auth-keycloak';
import { ChildrenAggregator, DashboardView } from './children.aggregator';
import { DashboardCache } from './dashboard.cache';
import { DownstreamError } from '../downstream/downstream.client';

interface ReqWithToken {
  user: AuthenticatedPrincipal;
  headers: Record<string, string | undefined>;
}

// Minimal Response shape — the BFF doesn't depend on @types/express
// directly; this captures just the methods we use.
interface ResponseLike {
  status(code: number): ResponseLike;
  setHeader(name: string, value: string | string[]): void;
}

/**
 * The parent's "today" surface.
 *
 *   GET /api/me/dashboard
 *     → 200 { children: [...with enrollments...], asOf, degraded }
 *
 * Authorization: KeycloakAuthGuard validates the JWT. The aggregator
 * forwards the SAME JWT to SIS + academic — those services apply their
 * own RLS/ABAC. The BFF derives child IDs from `listChildren()` (which
 * uses the parent's auth context); arbitrary `?childId=...` query
 * params are NOT honored.
 */
@Controller('me')
@UseGuards(KeycloakAuthGuard)
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(
    private readonly aggregator: ChildrenAggregator,
    private readonly cache: DashboardCache,
  ) {}

  @Get('dashboard')
  async dashboard(
    @Req() req: ReqWithToken,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<DashboardView | undefined> {
    const tenantId = req.user.tenantId;
    const userId = req.user.userId;
    if (!tenantId) {
      throw new HttpException(
        'tenant context required (token has no tenant_id claim)',
        400,
      );
    }
    const token = extractBearer(req);

    // Cache lookup. The key is (tenantId, userId, day) — the actor
    // segment is non-negotiable. Without it, parent A's cached
    // response could be served to parent B in the same tenant.
    const cached = await this.cache.get(tenantId, userId);
    if (cached) {
      // If-None-Match handling for client-side conditional requests.
      // 304 + ETag header lets the client skip the body entirely.
      const ifNoneMatch = req.headers['if-none-match'];
      res.setHeader('ETag', cached.etag);
      res.setHeader('X-Cache', 'HIT');
      if (ifNoneMatch && ifNoneMatch === cached.etag) {
        res.status(304);
        return undefined;
      }
      return cached.value;
    }

    let view: DashboardView;
    try {
      view = await this.aggregator.aggregate(token);
    } catch (err) {
      if (err instanceof DownstreamError) {
        if (err.status === 401 || err.status === 403) {
          throw new HttpException(
            { message: err.message, downstreamStatus: err.status },
            err.status,
          );
        }
        throw new HttpException(
          { message: 'dashboard unavailable; retry shortly', cause: err.message },
          503,
        );
      }
      throw err;
    }

    const stored = await this.cache.set(tenantId, userId, view);
    res.setHeader('ETag', stored.etag);
    res.setHeader('X-Cache', 'MISS');
    return view;
  }
}

function extractBearer(req: ReqWithToken): string {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    // The guard would have rejected already; defensive throw.
    throw new HttpException('missing bearer token', 401);
  }
  return auth.slice('Bearer '.length).trim();
}
