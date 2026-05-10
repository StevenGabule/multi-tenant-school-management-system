import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeycloakService } from '@org/auth-keycloak';

/**
 * HTTP client used by saga steps to call sis-service / academic-service.
 *
 * Three senior moves baked in:
 *
 *   1. Idempotency-Key on every cross-service call. The header carries
 *      `<sagaId>:<stepIndex>` so a retry of the same step yields the
 *      same downstream side effect (the receiver dedups on its end —
 *      see milestone 1.5 step 6). Without this, retries duplicate
 *      students, slots, etc.
 *
 *   2. Service-account auth via Keycloak's client_credentials grant.
 *      The enrollment-service's identity is `services` (the confidential
 *      client). The token is fetched once, cached for ~80% of its
 *      lifetime, then refreshed. NO tenant context in the token itself
 *      (service tokens are tenant-agnostic by design).
 *
 *   3. Tenant context per-request via X-Tenant-Id header. Because the
 *      service token has no tenant_id claim, the saga declares the
 *      tenant out-of-band. KeycloakAuthGuard accepts this header ONLY
 *      for service tokens (user tokens always carry tenant in the JWT).
 *      This separation keeps service-to-service auth audit-clean: logs
 *      can distinguish "saga acted on tenant T" from "user U acted on
 *      tenant T".
 *
 * Migration from milestone 1.5: the JWT_SECRET-forging mintToken() is
 * gone. The first `getServiceToken()` call is a network round-trip to
 * Keycloak (~30ms). Subsequent calls hit the cache (zero latency).
 */
@Injectable()
export class CrossServiceClient implements OnModuleInit {
  private readonly logger = new Logger(CrossServiceClient.name);
  private readonly sisBaseUrl: string;
  private readonly academicBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  /**
   * Cached service token. Refreshed when expiresAt is within
   * REFRESH_BEFORE_EXPIRY_MS of now. Single in-flight fetch is gated by
   * `inflightFetch` so a burst of saga steps doesn't trigger N parallel
   * token requests.
   */
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private inflightFetch: Promise<string> | null = null;
  private static readonly REFRESH_BEFORE_EXPIRY_MS = 60_000;

  constructor(
    config: ConfigService,
    private readonly keycloak: KeycloakService,
  ) {
    this.sisBaseUrl = config.getOrThrow<string>('SIS_SERVICE_BASE_URL');
    this.academicBaseUrl = config.getOrThrow<string>(
      'ACADEMIC_SERVICE_BASE_URL',
    );
    this.clientId = config.getOrThrow<string>('KEYCLOAK_SERVICES_CLIENT_ID');
    this.clientSecret = config.getOrThrow<string>(
      'KEYCLOAK_SERVICES_CLIENT_SECRET',
    );
  }

  async onModuleInit(): Promise<void> {
    // Fail fast on bad config: try one token fetch at startup. If the
    // services client's secret is wrong, we want to know now, not on
    // the first saga tick.
    try {
      await this.getServiceToken();
      this.logger.log(
        'CrossServiceClient: service token fetched (Keycloak client_credentials)',
      );
    } catch (err) {
      this.logger.error(
        `CrossServiceClient: token fetch FAILED at startup — saga steps will fail until Keycloak is reachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async getServiceToken(): Promise<string> {
    const now = Date.now();
    if (
      this.cachedToken &&
      this.cachedToken.expiresAt - now > CrossServiceClient.REFRESH_BEFORE_EXPIRY_MS
    ) {
      return this.cachedToken.token;
    }
    if (this.inflightFetch) return this.inflightFetch;

    this.inflightFetch = (async () => {
      const params = new URLSearchParams();
      params.set('grant_type', 'client_credentials');
      params.set('client_id', this.clientId);
      params.set('client_secret', this.clientSecret);
      const res = await fetch(this.keycloak.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `service token fetch failed: ${res.status} ${text.slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as {
        access_token: string;
        expires_in: number;
      };
      this.cachedToken = {
        token: json.access_token,
        expiresAt: now + json.expires_in * 1000,
      };
      return json.access_token;
    })();
    try {
      return await this.inflightFetch;
    } finally {
      this.inflightFetch = null;
    }
  }

  private async authHeaders(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.getServiceToken()}`,
      'X-Tenant-Id': tenantId,
      'Idempotency-Key': idempotencyKey,
    };
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
    const headers = await this.authHeaders(args.tenantId, args.idempotencyKey);
    const res = await fetch(`${this.sisBaseUrl}/api/students`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
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

  async softDeleteStudent(args: {
    tenantId: string;
    idempotencyKey: string;
    studentId: string;
  }): Promise<void> {
    const headers = await this.authHeaders(args.tenantId, args.idempotencyKey);
    const res = await fetch(
      `${this.sisBaseUrl}/api/students/${args.studentId}`,
      { method: 'DELETE', headers },
    );
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
    const headers = await this.authHeaders(args.tenantId, args.idempotencyKey);
    const res = await fetch(`${this.academicBaseUrl}/api/enrollments`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
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
    const headers = await this.authHeaders(args.tenantId, args.idempotencyKey);
    const res = await fetch(
      `${this.academicBaseUrl}/api/enrollments/${args.enrollmentId}`,
      { method: 'DELETE', headers },
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
