/**
 * DI tokens for the auth-keycloak lib. In their own file so other
 * modules can import them without pulling in the guard or service —
 * which would trigger circular imports and the classic "undefined
 * @Inject token at runtime" failure.
 */

export const KEYCLOAK_OPTIONS = Symbol('KEYCLOAK_OPTIONS');
