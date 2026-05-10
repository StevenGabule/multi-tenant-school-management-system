/**
 * Thrown when the registry cannot reach tenant-service AND nothing useful
 * is cached. Callers should map this to a 503 (fail-closed); see ADR-0006.
 *
 * Distinct from "tenant not found" (returns null). Unreachable !== unknown.
 */
export class TenantRegistryUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TenantRegistryUnavailableError';
  }
}
