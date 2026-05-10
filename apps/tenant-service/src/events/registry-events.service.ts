import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Publishes "this tenant changed, drop your cache" notifications on
 * Redis pub/sub. Subscribers (gateway and any other service consuming
 * @org/tenant-registry) evict their LRU entry instantly.
 *
 * Invariants:
 *   - Publish happens AFTER the DB transaction commits. Rolling back a
 *     pub/sub message isn't possible — better to never publish than to
 *     publish wrongly.
 *   - Publish is best-effort. If Redis is briefly down, subscribers fall
 *     back to TTL eviction (60s LRU + 5min Redis cache). Eventual
 *     consistency, not no consistency.
 */
@Injectable()
export class RegistryEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistryEventsService.name);
  private readonly redis: Redis;
  private readonly channel: string;

  constructor(config: ConfigService) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
    });
    this.channel =
      config.get<string>('REDIS_INVALIDATION_CHANNEL') ??
      'sms:tenant:invalidated';
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect();
    this.logger.log(`registry-events ready (channel=${this.channel})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  async publishInvalidation(tenantId: string): Promise<void> {
    try {
      // Clear the shared Redis cache FIRST so any new request that arrives
      // before the pub/sub message lands still misses Redis and hits the
      // source of truth. Then publish so existing subscribers drop their
      // process-local LRU.
      await this.redis.del(`tenant:${tenantId}`);
      const subscribers = await this.redis.publish(this.channel, tenantId);
      this.logger.debug(
        `invalidated ${tenantId} -> ${subscribers} subscriber(s)`,
      );
    } catch (err) {
      // Don't propagate — TTL fallback handles eventual consistency.
      this.logger.warn(
        `Redis publish/del failed for ${tenantId}: ${(err as Error).message}`,
      );
    }
  }
}
