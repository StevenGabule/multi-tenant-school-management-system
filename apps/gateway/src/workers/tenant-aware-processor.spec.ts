import { ClsService } from 'nestjs-cls';
import { PrismaService, TenantTx } from '../prisma/prisma.service';
import {
  TenantAwareJobPayload,
  TenantAwareProcessor,
} from './tenant-aware-processor';

interface DemoPayload extends TenantAwareJobPayload {
  echo: string;
}

class DemoProcessor extends TenantAwareProcessor<DemoPayload> {
  // Track what process() was called with so we can assert from the test
  public lastReceived: { payload: DemoPayload; tx: TenantTx } | null = null;

  protected async process(payload: DemoPayload, tx: TenantTx) {
    this.lastReceived = { payload, tx };
    return { ok: true, echo: payload.echo };
  }
}

describe('TenantAwareProcessor', () => {
  let prisma: { withTenant: jest.Mock };
  let cls: { run: jest.Mock; set: jest.Mock };

  beforeEach(() => {
    prisma = {
      withTenant: jest.fn(async (_id: string, fn: (tx: unknown) => unknown) =>
        fn('FAKE_TX'),
      ),
    };
    cls = {
      // The new pattern: cls.run(fn) opens a context, then cls.set(...) to populate.
      run: jest.fn(async (fn: () => unknown) => fn()),
      set: jest.fn(),
    };
  });

  it('refuses to process payloads missing tenantId', async () => {
    const proc = new DemoProcessor(
      prisma as unknown as PrismaService,
      cls as unknown as ClsService,
    );
    await expect(
      proc.run({ echo: 'hi' } as unknown as DemoPayload),
    ).rejects.toThrow(/missing tenantId/);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(cls.run).not.toHaveBeenCalled();
    expect(cls.set).not.toHaveBeenCalled();
  });

  it('seeds CLS and opens withTenant before calling process', async () => {
    const proc = new DemoProcessor(
      prisma as unknown as PrismaService,
      cls as unknown as ClsService,
    );
    const result = await proc.run({
      tenantId: '11111111-1111-1111-1111-111111111111',
      userId: 'user-1',
      requestId: 'req-1',
      echo: 'hello',
    });

    expect(result).toEqual({ ok: true, echo: 'hello' });
    // cls.run opens a fresh context, then cls.set is called per key
    expect(cls.run).toHaveBeenCalledTimes(1);
    expect(cls.set).toHaveBeenCalledWith(
      'tenantId',
      '11111111-1111-1111-1111-111111111111',
    );
    expect(cls.set).toHaveBeenCalledWith('userId', 'user-1');
    expect(cls.set).toHaveBeenCalledWith('requestId', 'req-1');
    expect(prisma.withTenant).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      expect.any(Function),
    );
    // process() was given the tx from withTenant
    expect(proc.lastReceived?.tx).toBe('FAKE_TX');
  });
});
