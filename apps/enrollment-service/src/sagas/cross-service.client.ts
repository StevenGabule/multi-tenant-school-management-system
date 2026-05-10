import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

/**
 * HTTP client used by saga steps to call sis-service / academic-service.
 *
 * Two senior moves baked in:
 *
 *   1. Idempotency-Key on every cross-service call. The header carries
 *      `<sagaId>:<stepIndex>` so a retry of the same step yields the
 *      same downstream side effect (the receiver dedups on its end —
 *      see milestone 1.5 step 6). Without this, retries duplicate
 *      students, slots, etc.
 *
 *   2. The enrollment-service forges a short-lived JWT for the saga's
 *      tenant. Today (Phase 1) it signs with the same JWT_SECRET as the
 *      gateway; in milestone 1.6 this is replaced with Keycloak service-
 *      account credentials. The TENANCY claim must match the saga's
 *      tenant — never elevated, never cross-tenant.
 */
@Injectable()
export class CrossServiceClient {
  private readonly sisBaseUrl: string;
  private readonly academicBaseUrl: string;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    this.sisBaseUrl = config.getOrThrow<string>('SIS_SERVICE_BASE_URL');
    this.academicBaseUrl = config.getOrThrow<string>(
      'ACADEMIC_SERVICE_BASE_URL',
    );
  }

  /**
   * Mint a tenant-scoped JWT for one outbound call. Short-lived (60s)
   * and tagged with sub=service:enrollment-saga so receivers can audit
   * traffic source.
   */
  private mintToken(tenantId: string): string {
    return this.jwt.sign(
      { sub: 'service:enrollment-saga', tenantId, roles: ['service'] },
      { expiresIn: '60s' },
    );
  }

  async createStudent(args: {
    tenantId: string;
    idempotencyKey: string;
    body: {
      firstName: string;
      middleName?: string;
      lastName: string;
      dateOfBirth: string;
      email?: string;
      phone?: string;
      gender?: string;
      externalId?: string;
    };
  }): Promise<{ id: string; externalId: string | null }> {
    const token = this.mintToken(args.tenantId);
    const res = await fetch(`${this.sisBaseUrl}/api/students`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': args.idempotencyKey,
      },
      body: JSON.stringify(args.body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new CrossServiceCallError(
        `sis.createStudent failed: ${res.status} ${text}`,
        res.status,
      );
    }
    return (await res.json()) as { id: string; externalId: string | null };
  }

  /**
   * Soft-deletes a student via SIS. Used as the compensation for
   * create-student. Idempotent — repeat calls return the same shape and
   * don't error if the student is already deleted.
   */
  async softDeleteStudent(args: {
    tenantId: string;
    idempotencyKey: string;
    studentId: string;
  }): Promise<void> {
    const token = this.mintToken(args.tenantId);
    const res = await fetch(
      `${this.sisBaseUrl}/api/students/${args.studentId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': args.idempotencyKey,
        },
      },
    );
    // 204 (deleted), 200 (also fine), 404 (already gone — idempotent
    // success) are all acceptable.
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new CrossServiceCallError(
        `sis.softDeleteStudent failed: ${res.status} ${text}`,
        res.status,
      );
    }
  }

  async confirmEnrollment(args: {
    tenantId: string;
    idempotencyKey: string;
    body: { studentId: string; classId: string };
  }): Promise<{ id: string; status: string }> {
    const token = this.mintToken(args.tenantId);
    const res = await fetch(`${this.academicBaseUrl}/api/enrollments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': args.idempotencyKey,
      },
      body: JSON.stringify(args.body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new CrossServiceCallError(
        `academic.confirmEnrollment failed: ${res.status} ${text}`,
        res.status,
      );
    }
    return (await res.json()) as { id: string; status: string };
  }

  async cancelEnrollment(args: {
    tenantId: string;
    idempotencyKey: string;
    enrollmentId: string;
  }): Promise<void> {
    const token = this.mintToken(args.tenantId);
    const res = await fetch(
      `${this.academicBaseUrl}/api/enrollments/${args.enrollmentId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': args.idempotencyKey,
        },
      },
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new CrossServiceCallError(
        `academic.cancelEnrollment failed: ${res.status} ${text}`,
        res.status,
      );
    }
  }
}

export class CrossServiceCallError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'CrossServiceCallError';
  }
}
