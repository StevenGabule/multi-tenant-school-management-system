import { InvariantViolation } from '../errors';

// Pragmatic regex — RFC 5322 in full is hostile. This catches the
// "looks like an email" mistakes; real validation is server-side delivery.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class Email {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly __brand: 'Email' = 'Email';

  private constructor(public readonly value: string) {}

  static from(raw: string): Email {
    const trimmed = (raw ?? '').trim().toLowerCase();
    if (trimmed.length === 0) {
      throw new InvariantViolation('Email cannot be empty');
    }
    if (trimmed.length > 254) {
      throw new InvariantViolation('Email exceeds 254 characters');
    }
    if (!EMAIL_RE.test(trimmed)) {
      throw new InvariantViolation(`Email format invalid: "${raw}"`);
    }
    return new Email(trimmed);
  }

  /** Lower-case domain portion (e.g., "school.edu"). */
  domain(): string {
    return this.value.split('@', 2)[1] ?? '';
  }

  toString(): string {
    return this.value;
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }
}
