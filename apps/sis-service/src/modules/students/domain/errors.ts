/**
 * Base for any error originating in the domain layer (invariant violation,
 * business rule violation, etc.). The application layer maps these to
 * appropriate HTTP responses; the domain itself remains framework-agnostic.
 */
export class DomainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class InvariantViolation extends DomainError {}
export class StudentNotFound extends DomainError {
  constructor(id: string) {
    super(`Student not found: ${id}`);
  }
}
