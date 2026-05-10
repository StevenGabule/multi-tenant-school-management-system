import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ChildView {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string | null;
  email: string | null;
}

export interface EnrollmentView {
  id: string;
  studentId: string;
  classId: string;
  status: string;
  createdAt: string;
}

/**
 * HTTP client for the BFF's downstream services. The BFF FORWARDS the
 * parent's JWT — receiving services revalidate the token (Keycloak
 * JWKS) and apply their own RLS/ABAC. The BFF is the first wall, not
 * the only wall.
 *
 * Why forward the user JWT instead of forging a service token:
 *   - Receiving services see the real actor (user.tenantId, user.sub).
 *     RLS in SIS filters student rows by parent guardianship using the
 *     SET LOCAL app.current_user_id = sub pattern from milestone 1.6.
 *   - No service token caching to manage in this hot path.
 *   - If the user's token is revoked/expired, the request fails at
 *     the receiver — no need to track that state at the BFF.
 *
 * Why a per-call timeout: a slow SIS shouldn't make the dashboard hang.
 * The default 250ms is a budget, not a target — typical local-Postgres
 * round-trip is ~10-30ms. The BFF retries are deliberately absent;
 * higher up (the controller) handles partial responses on failure.
 */
@Injectable()
export class DownstreamClient {
  private readonly logger = new Logger(DownstreamClient.name);
  private readonly sisBaseUrl: string;
  private readonly academicBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.sisBaseUrl = config.getOrThrow<string>('SIS_SERVICE_BASE_URL');
    this.academicBaseUrl = config.getOrThrow<string>(
      'ACADEMIC_SERVICE_BASE_URL',
    );
    this.timeoutMs = Number(
      config.get<string>('BFF_DOWNSTREAM_TIMEOUT_MS') ?? '250',
    );
  }

  async listChildren(token: string): Promise<ChildView[]> {
    const data = await this.getJson<Array<{
      id: string;
      firstName: string;
      middleName: string | null;
      lastName: string;
      dateOfBirth: string | null;
      email: string | null;
    }>>(`${this.sisBaseUrl}/api/students`, token);
    return data.map((d) => ({
      id: d.id,
      firstName: d.firstName,
      middleName: d.middleName,
      lastName: d.lastName,
      dateOfBirth: d.dateOfBirth,
      email: d.email,
    }));
  }

  async listEnrollments(
    token: string,
    studentIds: readonly string[],
  ): Promise<EnrollmentView[]> {
    if (studentIds.length === 0) return [];
    const url = `${this.academicBaseUrl}/api/enrollments?studentIds=${studentIds.join(',')}`;
    return this.getJson<EnrollmentView[]>(url, token);
  }

  /**
   * Surface ANY non-2xx as DownstreamError so callers can decide between
   * "fail this request" and "render partial." We deliberately don't
   * retry — retries belong further up where the request budget is known.
   */
  private async getJson<T>(url: string, token: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // 401/403 from the receiver mean the user's token is
        // invalid/forbidden THERE — propagate the same status to the
        // parent client, don't pretend it's a 502.
        const body = await res.text();
        throw new DownstreamError(
          `downstream ${res.status} ${url}: ${body.slice(0, 200)}`,
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof DownstreamError) throw err;
      if ((err as { name?: string }).name === 'AbortError') {
        throw new DownstreamError(
          `downstream timeout ${this.timeoutMs}ms: ${url}`,
          504,
        );
      }
      throw new DownstreamError(
        `downstream network error ${url}: ${err instanceof Error ? err.message : 'unknown'}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class DownstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DownstreamError';
  }
}
