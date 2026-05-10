import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StudentEventsConsumer } from './student-events.consumer';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const STUDENT_A = '22222222-2222-4222-8222-222222222222';
const EVENT_A = '33333333-3333-4333-8333-333333333333';

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: EVENT_A,
    tenantId: TENANT_A,
    aggregateId: STUDENT_A,
    aggregateType: 'Student',
    eventType: 'student.created',
    payload: { studentId: STUDENT_A, firstName: 'Ada', lastName: 'Lovelace' },
    metadata: {},
    occurredAt: new Date().toISOString(),
    ...overrides,
  });
}

interface FakeTx {
  $queryRawUnsafe: jest.Mock;
  enrollmentSlot: { create: jest.Mock };
}

function buildHarness() {
  const tx: FakeTx = {
    // First call returns [{eventId}] (insert effective); subsequent
    // calls return [] (ON CONFLICT — already there). The test toggles
    // this per scenario.
    $queryRawUnsafe: jest.fn(),
    enrollmentSlot: { create: jest.fn() },
  };
  const prisma = {
    withTenant: jest.fn(async (_id: string, fn: (tx: FakeTx) => unknown) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
  const config = {
    get: () => 'sms.sis.outbox',
    getOrThrow: () =>
      'postgresql://stub-not-used-in-unit-tests@localhost/none',
  } as unknown as ConfigService;
  return {
    tx,
    prisma,
    consumer: new StudentEventsConsumer(prisma, config),
  };
}

describe('StudentEventsConsumer', () => {
  it('drops malformed JSON without throwing', async () => {
    const h = buildHarness();
    await expect(h.consumer.onNotification('not-json')).resolves.toBeUndefined();
    expect(h.tx.enrollmentSlot.create).not.toHaveBeenCalled();
  });

  it('drops envelopes with malformed tenantId', async () => {
    const h = buildHarness();
    await h.consumer.onNotification(envelope({ tenantId: 'not-uuid' }));
    expect(h.tx.enrollmentSlot.create).not.toHaveBeenCalled();
  });

  it('runs the handler ONCE on first delivery, skips on dedup', async () => {
    const h = buildHarness();
    // First delivery — INSERT returns the eventId (succeeded)
    h.tx.$queryRawUnsafe.mockResolvedValueOnce([{ eventId: EVENT_A }]);
    await h.consumer.onNotification(envelope());
    expect(h.tx.enrollmentSlot.create).toHaveBeenCalledTimes(1);
    expect(h.tx.enrollmentSlot.create).toHaveBeenCalledWith({
      data: { tenantId: TENANT_A, studentId: STUDENT_A, status: 'pending' },
    });

    // Second delivery — INSERT returns [] (ON CONFLICT)
    h.tx.$queryRawUnsafe.mockResolvedValueOnce([]);
    await h.consumer.onNotification(envelope());
    // Still ONE create call total
    expect(h.tx.enrollmentSlot.create).toHaveBeenCalledTimes(1);
  });

  it('marks unknown event types as processed but does NOT call any handler', async () => {
    const h = buildHarness();
    h.tx.$queryRawUnsafe.mockResolvedValueOnce([{ eventId: EVENT_A }]);
    await h.consumer.onNotification(
      envelope({ eventType: 'student.unknown' }),
    );
    // processed_event was claimed (insert), but no enrollment_slot
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalled();
    expect(h.tx.enrollmentSlot.create).not.toHaveBeenCalled();
  });

  it('rejects student.created events without studentId in payload', async () => {
    const h = buildHarness();
    h.tx.$queryRawUnsafe.mockResolvedValueOnce([{ eventId: EVENT_A }]);
    await h.consumer.onNotification(envelope({ payload: {} }));
    // Handler threw → enrollmentSlot.create wasn't called → tx rolled back
    // (in production; here we just verify the create didn't happen)
    expect(h.tx.enrollmentSlot.create).not.toHaveBeenCalled();
  });
});
