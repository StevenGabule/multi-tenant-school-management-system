import {
  Controller,
  Get,
  HttpException,
  Logger,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedPrincipal,
  KeycloakAuthGuard,
} from '@org/auth-keycloak';
import { ChildrenAggregator, DashboardView } from './children.aggregator';
import { DownstreamError } from '../downstream/downstream.client';

interface ReqWithToken {
  user: AuthenticatedPrincipal;
  headers: Record<string, string | undefined>;
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

  constructor(private readonly aggregator: ChildrenAggregator) {}

  @Get('dashboard')
  async dashboard(@Req() req: ReqWithToken): Promise<DashboardView> {
    const token = extractBearer(req);
    try {
      return await this.aggregator.aggregate(token);
    } catch (err) {
      if (err instanceof DownstreamError) {
        // 401/403 from a downstream → propagate (the parent's token is
        // bad as far as the receiver is concerned). 5xx → 503 from the
        // BFF (we couldn't fulfill, the user should retry).
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
