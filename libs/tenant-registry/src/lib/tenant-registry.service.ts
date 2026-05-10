import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import { TenantRegistryUnavailableError } from './tenant-registry.errors';
import { Tenant } from './tenant.types';

export const TENANT_REGISTRY_OPTIONS = Symbol('TENANT_REGISTRY_OPTIONS');

export interface TenantRegistryOptions {
  /** Base URL of the tenant-service (no trailing slash). */
  baseUrl: string;
  /** Redis connection URL (e.g. redis://localhost:6379). */
  redisUrl: string;
  /** Pub/sub channel name for invalidation events. Defaults to 'sms:tenant:invalidated'. */
  invalidationChannel?: string;
  /** LRU max entries (process-local). Defaults to 10_000. */
  lruSize?: number;
  /** LRU TTL ms. Defaults to 60_000 (60s). */
  lruTtlMs?: number;
  /** Redis cache TTL seconds. Defaults to 300 (5 min). */
  redisTtlSeconds?: number;
  /** Per-call HTTP timeout ms. Defaults to 1500. */
  httpTimeoutMs?: number;
}

interface ResolveStat {
  hits: { lru: number; redis: number; http: number };
  misses: number;
  unavailable: number;
  invalidations: number;
}

/**
 * Three-layer tenant registry client:
 *
 *   request → process-LRU (60s) → Redis (5min) → tenant-service HTTP
 *
 * The shape was chosen deliberately:
 *   - LRU avoids a network roundtrip for hot tenants (every request from
 *     them hits this cache).
 *   - Redis lets multiple pods share warm data (also bridges the gap when
 *     a fresh pod has empty LRU but the tenant was looked up minutes ago).
 *   - HTTP is the source of truth; other layers eventually expire.
 *
 * Invalidation: tenant-service publishes 'tenant:<id>' on a Redis channel
 * after every mutation (milestone 1.2 step 8). Subscribers evict their
 * LRU entry instantly. Combined with the 60s TTL fallback for missed
 * messages and Phase 2 startup catch-up.
 *
 * Failure mode: when the HTTP layer fails AND nothing useful is cached,
 * we throw TenantRegistryUnavailableError. Callers should map to 503
 * (fail-closed) — see ADR-0006.
 */
@Injectable()
export class TenantRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantRegistryService.name);

  // LRU constraints values to non-null, so we wrap. The wrapper also lets
  // us cache "known not found" (tenant: null) without confusing it with
  // "no entry yet" (lru.get returns undefined).
  private readonly lru: LRUCache<string, { tenant: Tenant | null }>;
  private readonly redis: Redis;
  private readonly subRedis: Redis;
  private readonly channel: string;
  private readonly httpTimeoutMs: number;
  private readonly redisTtlSeconds: number;

  // In-process counters for the metrics step (1.2/9). Exposed via getStats().
  // OTel instrumentation hooks in once we know the metric shape we want.
  private readonly stat: ResolveStat = {
    hits: { lru: 0, redis: 0, http: 0 },
    misses: 0,
    unavailable: 0,
    invalidations: 0,
  };

  constructor(
    @Inject(TENANT_REGISTRY_OPTIONS) opts: TenantRegistryOptions,
  ) {
    this.lru = new LRUCache<string, { tenant: Tenant | null }>({
      max: opts.lruSize ?? 10_000,
      ttl: opts.lruTtlMs ?? 60_000,
    });
    this.redis = new Redis(opts.redisUrl, { lazyConnect: true });
    this.subRedis = new Redis(opts.redisUrl, { lazyConnect: true });
    this.channel = opts.invalidationChannel ?? 'sms:tenant:invalidated';
    this.httpTimeoutMs = opts.httpTimeoutMs ?? 1500;
    this.redisTtlSeconds = opts.redisTtlSeconds ?? 300;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  private readonly baseUrl: string;

  async onModuleInit(): Promise<void> {
    await Promise.all([this.redis.connect(), this.subRedis.connect()]);
    await this.subRedis.subscribe(this.channel);
    this.subRedis.on('message', (_ch, msg) => {
      // Drop our process-local LRU. The Redis-shared cache is the
      // publisher's responsibility (tenant-service deletes the key
      // before publishing), so we don't need to del it here.
      this.lru.delete(msg);
      this.stat.invalidations++;
      this.logger.debug(`invalidated ${msg} (pub/sub)`);
    });
    this.logger.log(`subscribed to ${this.channel}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.subRedis.unsubscribe(this.channel).catch(() => undefined);
    await Promise.all([
      this.redis.quit().catch(() => undefined),
      this.subRedis.quit().catch(() => undefined),
    ]);
  }

  /**
   * Returns the tenant or null if confirmed not-found upstream.
   * Throws TenantRegistryUnavailableError when upstream is unreachable
   * AND nothing is cached. Callers should fail-closed (503) on this error.
   */
  async findById(id: string): Promise<Tenant | null> {
    // L1 — process LRU
    const cached = this.lru.get(id);
    if (cached !== undefined) {
      this.stat.hits.lru++;
      return cached.tenant;
    }

    // L2 — Redis (shared across pods)
    let redisRaw: string | null = null;
    try {
      redisRaw = await this.redis.get(this.key(id));
    } catch (err) {
      this.logger.warn(`Redis read failed for ${id}: ${(err as Error).message}`);
      // Not fatal — fall through to HTTP
    }
    if (redisRaw !== null) {
      this.stat.hits.redis++;
      const tenant = JSON.parse(redisRaw) as Tenant | null;
      this.lru.set(id, { tenant });
      return tenant;
    }

    // L3 — HTTP source of truth
    let fetched: Tenant | null;
    try {
      fetched = await this.fetchFromService(id);
      this.stat.hits.http++;
    } catch (err) {
      this.stat.unavailable++;
      throw new TenantRegistryUnavailableError(
        `tenant-service unreachable for ${id}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (fetched === null) this.stat.misses++;

    // Populate upper layers (cache nulls too — "not found" stays found)
    void this.redis
      .set(this.key(id), JSON.stringify(fetched), 'EX', this.redisTtlSeconds)
      .catch((err) =>
        this.logger.warn(`Redis write failed for ${id}: ${err.message}`),
      );
    this.lru.set(id, { tenant: fetched });
    return fetched;
  }

  /**
   * Manual invalidation. tenant-service calls this (or publishes on the
   * channel directly) after every mutation. Eagerly clears LRU + Redis
   * so the next lookup goes to the source of truth.
   */
  async invalidate(id: string): Promise<void> {
    this.lru.delete(id);
    await this.redis.del(this.key(id)).catch(() => undefined);
    await this.redis
      .publish(this.channel, id)
      .catch((err) =>
        this.logger.warn(`Redis publish failed for ${id}: ${err.message}`),
      );
  }

  getStats(): Readonly<ResolveStat> {
    return { ...this.stat, hits: { ...this.stat.hits } };
  }

  private key(id: string): string {
    return `tenant:${id}`;
  }

  private async fetchFromService(id: string): Promise<Tenant | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.httpTimeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/api/tenants/${id}`, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (await resp.json()) as Tenant;
    } finally {
      clearTimeout(timer);
    }
  }
}
