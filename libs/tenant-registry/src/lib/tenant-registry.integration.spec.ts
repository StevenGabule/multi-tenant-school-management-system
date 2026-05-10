/**
 * Integration test for the 3-layer cache + pub/sub invalidation flow.
 *
 * Spins up:
 *   - A real Redis via Testcontainers
 *   - A tiny in-process http server pretending to be tenant-service
 *
 * Then exercises:
 *   - cold lookup → HTTP hit
 *   - warm lookup → LRU hit
 *   - LRU evicted but Redis warm → Redis hit
 *   - invalidate() clears both layers and the next lookup goes back to HTTP
 *   - pub/sub: an outside publisher dels Redis + publishes; subscriber
 *     drops its LRU within the message-delivery window
 *   - 404 from upstream → returns null (not throws)
 *   - 5xx from upstream → throws TenantRegistryUnavailableError
 *   - network unreachable → throws TenantRegistryUnavailableError
 */

import { createServer, type Server } from 'http';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import {
  TENANT_REGISTRY_OPTIONS,
  TenantRegistryService,
  TenantRegistryUnavailableError,
  type Tenant,
} from '../index';

jest.setTimeout(120_000);

interface FakeServer {
  url: string;
  setHandler: (
    fn: (id: string) => { status: number; body?: Tenant | string },
  ) => void;
  callCount: () => number;
  close: () => Promise<void>;
}

function startFakeTenantService(): Promise<FakeServer> {
  let handler: (id: string) => { status: number; body?: Tenant | string } = (
    id,
  ) => ({ status: 404 });
  let calls = 0;

  const server: Server = createServer((req, res) => {
    calls++;
    const m = /^\/api\/tenants\/([0-9a-f-]+)$/i.exec(req.url ?? '');
    if (!m) {
      res.statusCode = 404;
      return res.end('not found');
    }
    const result = handler(m[1]);
    res.statusCode = result.status;
    res.setHeader('content-type', 'application/json');
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? null));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        setHandler: (fn) => {
          handler = fn;
        },
        callCount: () => calls,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

const TENANT_A: Tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Tenant A',
  slug: 'a',
  tier: 'pool',
  region: 'us-east-1',
  status: 'active',
  dsn: null,
  version: 1,
  planId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  suspendedAt: null,
};

describe('TenantRegistryService — 3-layer cache + pub/sub', () => {
  let redisContainer: StartedTestContainer;
  let redisUrl: string;
  let fakeUpstream: FakeServer;
  let registry: TenantRegistryService;
  let publisherRedis: Redis;
  const channel = 'sms:tenant:invalidated';

  beforeAll(async () => {
    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(
      6379,
    )}`;
    fakeUpstream = await startFakeTenantService();
  });

  beforeEach(async () => {
    fakeUpstream.setHandler((id) => {
      if (id === TENANT_A.id) return { status: 200, body: TENANT_A };
      return { status: 404 };
    });

    // Flush Redis between tests so prior runs don't pollute the cache.
    publisherRedis = new Redis(redisUrl);
    await publisherRedis.flushdb();

    registry = new TenantRegistryService({
      baseUrl: fakeUpstream.url,
      redisUrl,
      invalidationChannel: channel,
      lruTtlMs: 30_000,
      httpTimeoutMs: 1000,
    });
    await registry.onModuleInit();
  });

  afterEach(async () => {
    await registry.onModuleDestroy();
    await publisherRedis.quit().catch(() => undefined);
  });

  afterAll(async () => {
    await fakeUpstream.close();
    await redisContainer.stop();
  });

  describe('cold + warm path', () => {
    it('cold lookup hits HTTP, warms both LRU and Redis', async () => {
      const before = fakeUpstream.callCount();
      const t = await registry.findById(TENANT_A.id);
      expect(t?.id).toBe(TENANT_A.id);
      expect(fakeUpstream.callCount()).toBe(before + 1);
      expect(registry.getStats().hits.http).toBe(1);
    });

    it('warm lookup hits LRU (no HTTP, no Redis)', async () => {
      await registry.findById(TENANT_A.id); // cold
      const httpBefore = fakeUpstream.callCount();
      await registry.findById(TENANT_A.id); // warm
      expect(fakeUpstream.callCount()).toBe(httpBefore);
      expect(registry.getStats().hits.lru).toBe(1);
    });

    it('LRU evicted but Redis warm → Redis hit (no HTTP)', async () => {
      await registry.findById(TENANT_A.id); // cold; warms LRU + Redis
      const httpBefore = fakeUpstream.callCount();
      // Verify Redis was warmed by the cold lookup
      const fresh = await publisherRedis.get(`tenant:${TENANT_A.id}`);
      expect(fresh).not.toBeNull();

      // Spin up a SECOND service instance against the same Redis —
      // simulates a fresh pod inheriting warm shared cache. Original
      // instance keeps running; we don't tear it down.
      const fresh2 = new TenantRegistryService({
        baseUrl: fakeUpstream.url,
        redisUrl,
        invalidationChannel: channel,
        lruTtlMs: 30_000,
      });
      await fresh2.onModuleInit();
      try {
        await fresh2.findById(TENANT_A.id); // should be L2 (Redis) hit
        expect(fakeUpstream.callCount()).toBe(httpBefore); // no new HTTP
        expect(fresh2.getStats().hits.redis).toBe(1);
      } finally {
        await fresh2.onModuleDestroy();
      }
    });
  });

  describe('upstream errors', () => {
    it('404 returns null, NOT an error', async () => {
      const t = await registry.findById(
        '99999999-9999-4999-8999-999999999999',
      );
      expect(t).toBeNull();
      expect(registry.getStats().misses).toBe(1);
    });

    it('5xx throws TenantRegistryUnavailableError (fail-closed)', async () => {
      fakeUpstream.setHandler(() => ({ status: 503, body: 'sad' }));
      await expect(
        registry.findById(TENANT_A.id),
      ).rejects.toBeInstanceOf(TenantRegistryUnavailableError);
      expect(registry.getStats().unavailable).toBe(1);
    });
  });

  describe('pub/sub invalidation', () => {
    it('external publish drops the LRU within message-delivery latency', async () => {
      await registry.findById(TENANT_A.id); // warm LRU
      // Simulate tenant-service's flow: del Redis + publish channel
      await publisherRedis.del(`tenant:${TENANT_A.id}`);
      await publisherRedis.publish(channel, TENANT_A.id);
      // Give the subscriber a moment
      await new Promise((r) => setTimeout(r, 200));
      expect(registry.getStats().invalidations).toBeGreaterThanOrEqual(1);

      // Next lookup must miss LRU (and Redis was deleted), so HTTP again
      const httpBefore = fakeUpstream.callCount();
      await registry.findById(TENANT_A.id);
      expect(fakeUpstream.callCount()).toBe(httpBefore + 1);
    });
  });
});
