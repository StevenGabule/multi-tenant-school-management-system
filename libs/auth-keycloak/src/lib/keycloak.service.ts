import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JWTPayload, JWTVerifyResult, createRemoteJWKSet, jwtVerify } from 'jose';
import { KEYCLOAK_OPTIONS } from './tokens.js';
import type { KeycloakJwtPayload } from './keycloak-jwt.types.js';

interface KeycloakOptionsShape {
  issuerUrl: string;
  audience: string;
  jwksCacheMs?: number;
}

/**
 * KeycloakService handles the OIDC plumbing:
 *
 *   1. On startup, fetches /.well-known/openid-configuration to discover
 *      the realm's issuer + jwks_uri. Caches the result for the lifetime
 *      of the process.
 *   2. Builds a `createRemoteJWKSet` (jose) over the jwks_uri. The
 *      JWKSet itself caches keys, refreshes on unknown kid, and respects
 *      the cooldown (default 10 min).
 *   3. Exposes `verify(token)` that runs the full validation: signature,
 *      issuer, audience, nbf/exp, and returns the typed payload.
 *
 * Why jose (not jsonwebtoken + jwks-rsa): jose's `createRemoteJWKSet`
 * handles rotation correctly by default — when a token's kid isn't in
 * the cache, it refetches once. With jsonwebtoken + jwks-rsa we'd build
 * the cache + refresh logic ourselves, with subtle mistakes; jose is
 * the modern, well-tested choice.
 */
@Injectable()
export class KeycloakService implements OnModuleInit {
  private readonly logger = new Logger(KeycloakService.name);
  private discovery: { issuer: string; jwks_uri: string; token_endpoint: string } | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    @Inject(KEYCLOAK_OPTIONS)
    private readonly options: KeycloakOptionsShape,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadDiscovery();
  }

  private async loadDiscovery(): Promise<void> {
    const url = `${this.options.issuerUrl}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `KeycloakService: discovery fetch failed at ${url}: ${res.status}`,
      );
    }
    const doc = (await res.json()) as {
      issuer: string;
      jwks_uri: string;
      token_endpoint: string;
    };
    if (doc.issuer !== this.options.issuerUrl) {
      throw new Error(
        `KeycloakService: discovery issuer mismatch (got "${doc.issuer}", expected "${this.options.issuerUrl}")`,
      );
    }
    this.discovery = doc;
    this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri), {
      cacheMaxAge: this.options.jwksCacheMs ?? 10 * 60 * 1000,
      // Cooldown between refetches when an unknown kid is seen. Without
      // this, an attacker who feeds tokens with random kids could DDoS
      // the JWKS endpoint.
      cooldownDuration: 30_000,
    });
    this.logger.log(
      `Keycloak discovery loaded: issuer=${doc.issuer} jwks_uri=${doc.jwks_uri}`,
    );
  }

  /**
   * Verify a Keycloak access token. Throws on signature, iss, aud, exp,
   * or nbf failure. The payload returned is typed against KeycloakJwtPayload.
   */
  async verify(token: string): Promise<JWTVerifyResult<KeycloakJwtPayload>> {
    if (!this.jwks) {
      // OnModuleInit guarantees this is set; defensive throw so future
      // refactors can't silently bypass.
      throw new Error('KeycloakService used before discovery loaded');
    }
    return jwtVerify<KeycloakJwtPayload>(token, this.jwks, {
      issuer: this.options.issuerUrl,
      audience: this.options.audience,
    });
  }

  /**
   * Token endpoint URL. Used by service-to-service callers that fetch
   * client_credentials tokens (e.g., the enrollment saga's CrossServiceClient).
   */
  get tokenEndpoint(): string {
    if (!this.discovery) throw new Error('discovery not loaded');
    return this.discovery.token_endpoint;
  }

  /** The realm's expected issuer string. */
  get issuer(): string {
    return this.options.issuerUrl;
  }
}

// Re-export so consumers don't need to import jose directly for typing.
export type { JWTPayload };
