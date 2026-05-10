import { InvariantViolation } from '../errors';

// Permissive — phone numbers are messy globally. We strip formatting
// and require 7-15 digits (E.164 max). True validation belongs at SMS
// send time (carrier-specific).
const DIGITS_ONLY = /\D+/g;

export class Phone {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly __brand: 'Phone' = 'Phone';

  private constructor(public readonly value: string) {}

  /**
   * Stores normalized digits (no formatting). Accepts +1 (555) 123-4567,
   * 555.123.4567, 5551234567 — all become 15551234567.
   */
  static from(raw: string): Phone {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length === 0) {
      throw new InvariantViolation('Phone cannot be empty');
    }
    const digits = trimmed.replace(DIGITS_ONLY, '');
    if (digits.length < 7 || digits.length > 15) {
      throw new InvariantViolation(
        `Phone must contain 7–15 digits; got ${digits.length}`,
      );
    }
    return new Phone(digits);
  }

  toString(): string {
    return this.value;
  }

  equals(other: Phone): boolean {
    return this.value === other.value;
  }
}
