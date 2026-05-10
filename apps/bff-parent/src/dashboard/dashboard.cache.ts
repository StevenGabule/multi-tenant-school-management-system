import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { DashboardView } from './children.aggregator';

export interface CachedDashboard {
  value: DashboardView;
  etag: string;
}

/**
 * BFF cache for the /me/dashboard response.
 *
 * Key shape:
 *   bff:parent:dashboard:{tenantId}:{userId}:{day}
 *
 * Each segment matters:
 *   - tenantId  — same key across tenants would let parent A's cached
 *                 response leak to parent B in tenant Y. Don't.
 *   - userId    — same key across users in one tenant would do the
 *                 same within a tenant. Definitely don't.
 *   - day       — the dashboard's "today" semantics — at midnight UTC
 *                 the cache key changes naturally, so old data is
 *                 garbage-collected by Redis TTL without explicit
 *                 invalidation.
 *
 * TTL is short (BFF_DASHBOARD_CACHE_TTL_SEC, default 30s). The
 * dashboard tolerates 30 seconds of staleness; caching longer would
 * delay the visible effect of "I just enrolled my kid in a new class."
 *
 * EVENT-DRIVEN INVALIDATION (e.g., new enrollment → bust the parent's
 * dashboard cache) is NOT YET wired. The TTL is the only invalidator.
 * Phase 1.7 ships TTL-only; event-bust uses milestone 1.4's outbox
 * substrate and lands in milestone 1.8 alongside the rest of the
 * observability/eventing stack — documented as deferred.
 */
@Injectable()
export class DashboardCache implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardCache.name);
  private redis: Redis | null = null;
  private readonly ttlSec: number;
  private readonly redisUrl: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.ttlSec = Number(
      config.get<string>('BFF_DASHBOARD_CACHE_TTL_SEC') ?? '30',
    );
  }

  async onModuleInit(): Promise<void> {
    this.redis = new Redis(this.redisUrl, {
      // ioredis retries forever by default — fine for a service that
      // can tolerate cache outages by missing the cache. We log the
      // first failure and let it retry.
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
    this.redis.on('error', (err) => {
      this.logger.warn(`redis error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
      this.redis = null;
    }
  }

  /**
   * Cache lookup. Returns null on miss OR on Redis-side errors —
   * cache outage degrades to "always miss," never throws past the
   * caller. The whole point of the BFF cache is to be best-effort.
   */
  async get(tenantId: string, userId: string): Promise<CachedDashboard | null> {
    if (!this.redis) return null;
    const key = this.keyFor(tenantId, userId);
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as CachedDashboard;
    } catch (err) {
      this.logger.warn(
        `cache get failed (treating as miss): ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return null;
    }
  }

  async set(
    tenantId: string,
    userId: string,
    value: DashboardView,
  ): Promise<CachedDashboard> {
    const etag = etagFor(value);
    const cached: CachedDashboard = { value, etag };
    if (!this.redis) return cached;
    const key = this.keyFor(tenantId, userId);
    try {
      await this.redis.set(key, JSON.stringify(cached), 'EX', this.ttlSec);
    } catch (err) {
      this.logger.warn(
        `cache set failed (response served, not cached): ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
    return cached;
  }

  private keyFor(tenantId: string, userId: string): string {
    const day = new Date().toISOString().slice(0, 10);
    return `bff:parent:dashboard:${tenantId}:${userId}:${day}`;
  }
}

/**
 * Stable ETag — content-hash of the response. Used by the controller
 * for HTTP If-None-Match handling (304 Not Modified) and as a cache-
 * probe key for downstream client-side caches. Quoted per RFC 7232.
 */
function etagFor(value: DashboardView): string {
  const json = JSON.stringify(value);
  const hash = createHash('sha1').update(json).digest('hex').slice(0, 16);
  return `"${hash}"`;
}
