/**
 * The shape of an access token issued by Keycloak's `sms-platform` realm.
 *
 * Note: Keycloak's `sub` is the user UUID; `tenant_id` is our custom
 * claim emitted by the user-attribute mapper (see infra/keycloak/bootstrap.sh).
 * `realm_access.roles` is the standard Keycloak shape for realm-level
 * roles. Client-level roles would land under `resource_access.<client>.roles`
 * — we don't use those today.
 */
export interface KeycloakJwtPayload {
  /** Token id — useful for revocation lookups. */
  jti?: string;
  /** Issuer — must match KEYCLOAK_ISSUER_URL. */
  iss: string;
  /** Audience — must include KEYCLOAK_AUDIENCE (e.g., 'gateway'). */
  aud: string | string[];
  /** Subject — Keycloak user UUID. Maps to userId in CLS. */
  sub: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiration (epoch seconds). */
  exp: number;
  /** Not-before (epoch seconds), if present. */
  nbf?: number;

  /** Realm-level roles. Empty array when none assigned. */
  realm_access?: { roles?: string[] };

  /** Custom mapper output: tenant uuid scoping this user. */
  tenant_id?: string;

  /** Standard OIDC claims (optional). */
  preferred_username?: string;
  email?: string;
  given_name?: string;
  family_name?: string;

  /**
   * Service-account tokens (client_credentials grant) carry this claim
   * with the client_id of the service that authenticated. We surface it
   * for receivers that want to log "called by service X."
   */
  azp?: string;

  /** Allow extra claims without losing type-safety on the named ones. */
  [extra: string]: unknown;
}

/**
 * The validated request principal. Replaces the hand-rolled SmsJwtPayload
 * + tenant + roles arrangement used in milestones 1.1–1.5.
 */
export interface AuthenticatedPrincipal {
  /** Keycloak user UUID. */
  userId: string;
  /** Tenant uuid this user is acting on behalf of. */
  tenantId: string | null;
  /** Realm roles, e.g. ['parent', 'teacher']. */
  roles: string[];
  /** Original payload for callers that need an unmodeled claim. */
  raw: KeycloakJwtPayload;
}
