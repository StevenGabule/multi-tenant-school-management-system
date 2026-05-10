import {
  ChildView,
  DownstreamClient,
  DownstreamError,
  EnrollmentView,
} from '../downstream/downstream.client';
import { ChildrenAggregator } from './children.aggregator';

const PARENT_TOKEN = 'parent-bearer-token';
const TENANT = '11111111-1111-4111-8111-111111111111';
const PARENT_A_CHILD_1 = '22222222-2222-4222-8222-222222222001';
const PARENT_A_CHILD_2 = '22222222-2222-4222-8222-222222222002';
const PARENT_B_CHILD = '33333333-3333-4333-8333-333333333001';

function buildClient(): jest.Mocked<DownstreamClient> {
  return {
    listChildren: jest.fn(),
    listEnrollments: jest.fn(),
  } as unknown as jest.Mocked<DownstreamClient>;
}

function child(id: string, last: string): ChildView {
  return {
    id,
    firstName: 'Test',
    middleName: null,
    lastName: last,
    dateOfBirth: '2010-01-01',
    email: null,
  };
}

function enrollment(studentId: string): EnrollmentView {
  return {
    id: `enroll-${studentId.slice(0, 8)}`,
    studentId,
    classId: '99999999-9999-4999-8999-999999999999',
    status: 'confirmed',
    createdAt: new Date('2026-05-10T00:00:00Z').toISOString(),
  };
}

describe('ChildrenAggregator', () => {
  it('returns empty children when parent has none — no enrollment fetch', async () => {
    const client = buildClient();
    client.listChildren.mockResolvedValue([]);
    const agg = new ChildrenAggregator(client);

    const view = await agg.aggregate(PARENT_TOKEN);
    expect(view.children).toEqual([]);
    expect(view.degraded).toBe(false);
    expect(client.listEnrollments).not.toHaveBeenCalled();
  });

  it('parent A only sees parent-A children — derives IDs from authenticated children call', async () => {
    const client = buildClient();
    // SIS returns ONLY parent-A's children (RLS + ABAC filters before
    // they ever reach the BFF). Even if the BFF *attempted* to fetch
    // parent-B's child, it doesn't have the ID — listChildren is the
    // sole source of child IDs.
    client.listChildren.mockResolvedValue([
      child(PARENT_A_CHILD_1, 'Smith'),
      child(PARENT_A_CHILD_2, 'Smith'),
    ]);
    client.listEnrollments.mockImplementation(async (_t, ids) => {
      // Verify the ID flowing into academic comes from listChildren,
      // not from any ?childId= or other parent-controlled input.
      expect(ids).toHaveLength(1);
      expect([PARENT_A_CHILD_1, PARENT_A_CHILD_2]).toContain(ids[0]);
      return [enrollment(ids[0])];
    });
    const agg = new ChildrenAggregator(client);

    const view = await agg.aggregate(PARENT_TOKEN);
    expect(view.children.map((c) => c.id)).toEqual([
      PARENT_A_CHILD_1,
      PARENT_A_CHILD_2,
    ]);
    expect(view.children[0].enrollments[0].studentId).toBe(PARENT_A_CHILD_1);
    expect(view.degraded).toBe(false);

    // Parent B's child id never appeared in any downstream call.
    const allCalls = client.listEnrollments.mock.calls.flatMap((c) => c[1]);
    expect(allCalls).not.toContain(PARENT_B_CHILD);
  });

  it('parallelizes per-child enrollment fetches', async () => {
    const client = buildClient();
    client.listChildren.mockResolvedValue([
      child(PARENT_A_CHILD_1, 'A'),
      child(PARENT_A_CHILD_2, 'B'),
    ]);
    let inflight = 0;
    let maxInflight = 0;
    client.listEnrollments.mockImplementation(async (_t, ids) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      return [enrollment(ids[0])];
    });
    const agg = new ChildrenAggregator(client);
    await agg.aggregate(PARENT_TOKEN);
    // The two enrichment calls overlapped — parallelism is real, not
    // accidentally sequential.
    expect(maxInflight).toBe(2);
  });

  it('degrades partially when one childs enrichment fails', async () => {
    const client = buildClient();
    client.listChildren.mockResolvedValue([
      child(PARENT_A_CHILD_1, 'OK'),
      child(PARENT_A_CHILD_2, 'BadDownstream'),
    ]);
    client.listEnrollments.mockImplementation(async (_t, ids) => {
      if (ids[0] === PARENT_A_CHILD_2) {
        throw new DownstreamError('academic 504 timeout', 504);
      }
      return [enrollment(ids[0])];
    });
    const agg = new ChildrenAggregator(client);

    const view = await agg.aggregate(PARENT_TOKEN);
    expect(view.degraded).toBe(true);
    expect(view.children[0].enrollments).toHaveLength(1);
    expect(view.children[0].degraded).toBeUndefined();
    expect(view.children[1].enrollments).toEqual([]);
    expect(view.children[1].degraded?.reason).toContain('504');
  });

  it('propagates a children-list failure (no graceful default)', async () => {
    const client = buildClient();
    client.listChildren.mockRejectedValue(
      new DownstreamError('SIS 502', 502),
    );
    const agg = new ChildrenAggregator(client);
    await expect(agg.aggregate(PARENT_TOKEN)).rejects.toBeInstanceOf(
      DownstreamError,
    );
  });
});
