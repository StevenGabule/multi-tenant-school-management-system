import { Injectable, Logger } from '@nestjs/common';
import {
  ChildView,
  DownstreamClient,
  DownstreamError,
  EnrollmentView,
} from '../downstream/downstream.client';

export interface ChildWithEnrollments extends ChildView {
  enrollments: EnrollmentView[];
  /** Set when this child's enrichment hit a downstream failure and was
   *  rendered partially. Lets the API contract communicate "you got
   *  some of the data, not all." */
  degraded?: { reason: string };
}

export interface DashboardView {
  children: ChildWithEnrollments[];
  /** ISO date for the cache key boundary. Today's data is the dashboard
   *  shape; client caches/CDN can use this as the staleness signal. */
  asOf: string;
  /** True if any per-child enrichment failed; the response is partial. */
  degraded: boolean;
}

/**
 * The aggregator. Two senior moves:
 *
 *   1. PARALLELISM. The naive shape (children, then per-child
 *      enrollments sequentially) takes O(N+1) latency in N children.
 *      Promise.all on the per-child enrichment turns that into O(2)
 *      latency. The dependency graph is:
 *
 *        listChildren ──► [for each child] enrollments
 *                                   (independent ⇒ parallel)
 *
 *   2. PARTIAL RESPONSE on per-child failure. If one child's enrollment
 *      fetch times out, that child renders with `enrollments: []` and
 *      a `degraded` hint. The dashboard does NOT 5xx — the user sees
 *      9 of 10 children with full data and 1 child marked degraded.
 *      A complete failure of the children call DOES surface as a 5xx
 *      (no graceful default for "we don't even know the children").
 */
@Injectable()
export class ChildrenAggregator {
  private readonly logger = new Logger(ChildrenAggregator.name);

  constructor(private readonly client: DownstreamClient) {}

  async aggregate(token: string): Promise<DashboardView> {
    // Step A: Children list. Failure here is fatal — without children we
    // have nothing to render. Propagates DownstreamError; the controller
    // turns 401/403 into the same status, others into 502/503.
    const children = await this.client.listChildren(token);
    if (children.length === 0) {
      return { children: [], asOf: today(), degraded: false };
    }

    // Step B: Per-child enrollments in parallel. Each child's failure is
    // contained — we settle, not all-or-nothing.
    const settled = await Promise.allSettled(
      children.map((child) =>
        this.client.listEnrollments(token, [child.id]),
      ),
    );

    let degraded = false;
    const enriched: ChildWithEnrollments[] = children.map((child, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        return { ...child, enrollments: r.value };
      }
      degraded = true;
      const reason =
        r.reason instanceof DownstreamError
          ? `${r.reason.status} ${r.reason.message.slice(0, 120)}`
          : `error ${r.reason instanceof Error ? r.reason.message : 'unknown'}`;
      this.logger.warn(
        `child ${child.id} enrichment failed: ${reason}; rendering partial`,
      );
      return { ...child, enrollments: [], degraded: { reason } };
    });

    return { children: enriched, asOf: today(), degraded };
  }
}

function today(): string {
  // YYYY-MM-DD UTC. Same boundary as cache day-bucket so a client
  // refresh after midnight gets a fresh cache key.
  return new Date().toISOString().slice(0, 10);
}
