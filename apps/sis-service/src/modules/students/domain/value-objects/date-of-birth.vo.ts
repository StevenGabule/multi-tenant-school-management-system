import { InvariantViolation } from '../errors';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar date — days since 0001-01-01, no time, no timezone. Centralizes
 * the "must be in the past" invariant and the age calculation so callers
 * can't get those wrong.
 *
 * Stored internally as midnight UTC; serialized to ISO date string
 * (YYYY-MM-DD) when leaving the domain.
 */
export class DateOfBirth {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly __brand: 'DateOfBirth' = 'DateOfBirth';

  private constructor(public readonly value: Date) {}

  /**
   * Accepts an ISO date string (YYYY-MM-DD) or a Date. Rejects future
   * dates and dates before 1900-01-01 (typo guard — no enrolled student
   * is over 124).
   */
  static from(input: string | Date, now: Date = new Date()): DateOfBirth {
    let date: Date;
    if (typeof input === 'string') {
      if (!ISO_DATE_RE.test(input)) {
        throw new InvariantViolation(
          `DateOfBirth requires ISO date YYYY-MM-DD; got "${input}"`,
        );
      }
      date = new Date(`${input}T00:00:00.000Z`);
    } else {
      // Normalize Date to midnight UTC of the same calendar day.
      date = new Date(
        Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()),
      );
    }

    if (Number.isNaN(date.getTime())) {
      throw new InvariantViolation(`DateOfBirth could not parse "${String(input)}"`);
    }
    if (date.getTime() > now.getTime()) {
      throw new InvariantViolation(
        `DateOfBirth must be in the past; got ${date.toISOString().slice(0, 10)}`,
      );
    }
    if (date.getUTCFullYear() < 1900) {
      throw new InvariantViolation(
        `DateOfBirth before 1900 likely a typo; got ${date.toISOString().slice(0, 10)}`,
      );
    }

    return new DateOfBirth(date);
  }

  /** Whole-year age relative to `now`. */
  ageInYears(now: Date = new Date()): number {
    let age = now.getUTCFullYear() - this.value.getUTCFullYear();
    const beforeBirthday =
      now.getUTCMonth() < this.value.getUTCMonth() ||
      (now.getUTCMonth() === this.value.getUTCMonth() &&
        now.getUTCDate() < this.value.getUTCDate());
    if (beforeBirthday) age -= 1;
    return age;
  }

  /** YYYY-MM-DD; the wire format. */
  toISODate(): string {
    return this.value.toISOString().slice(0, 10);
  }

  toString(): string {
    return this.toISODate();
  }

  equals(other: DateOfBirth): boolean {
    return this.value.getTime() === other.value.getTime();
  }
}
