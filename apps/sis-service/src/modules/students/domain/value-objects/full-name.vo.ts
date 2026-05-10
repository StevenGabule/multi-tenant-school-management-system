import { InvariantViolation } from '../errors';

/**
 * Person name. Three parts (first/middle/last) reflects what the
 * student schema stores. Centralizes display formatting so we never
 * accidentally render "John  Doe" with a doubled space when middle is
 * absent, and so changes to "Last, First" formatting happen in ONE place.
 *
 * Names are unicode-aware (we don't restrict to ASCII; international
 * student records exist).
 */
export class FullName {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly __brand: 'FullName' = 'FullName';

  private constructor(
    public readonly firstName: string,
    public readonly lastName: string,
    public readonly middleName: string | null,
  ) {}

  static of(
    firstName: string,
    lastName: string,
    middleName?: string | null,
  ): FullName {
    const f = (firstName ?? '').trim();
    const l = (lastName ?? '').trim();
    const m = middleName?.trim() || null;

    if (f.length === 0) {
      throw new InvariantViolation('FullName.firstName cannot be empty');
    }
    if (l.length === 0) {
      throw new InvariantViolation('FullName.lastName cannot be empty');
    }
    if (f.length > 100) {
      throw new InvariantViolation('FullName.firstName must be ≤ 100 chars');
    }
    if (l.length > 100) {
      throw new InvariantViolation('FullName.lastName must be ≤ 100 chars');
    }
    if (m && m.length > 100) {
      throw new InvariantViolation('FullName.middleName must be ≤ 100 chars');
    }

    return new FullName(f, l, m);
  }

  /** "First Middle Last" with no doubled spaces when middle is absent. */
  display(): string {
    return [this.firstName, this.middleName, this.lastName]
      .filter((p): p is string => Boolean(p))
      .join(' ');
  }

  /** "Last, First" — common in school transcripts and rosters. */
  formal(): string {
    return `${this.lastName}, ${this.firstName}`;
  }

  initials(): string {
    const f = this.firstName.charAt(0).toUpperCase();
    const m = this.middleName ? this.middleName.charAt(0).toUpperCase() : '';
    const l = this.lastName.charAt(0).toUpperCase();
    return `${f}${m}${l}`;
  }

  toString(): string {
    return this.display();
  }

  equals(other: FullName): boolean {
    return (
      this.firstName === other.firstName &&
      this.lastName === other.lastName &&
      this.middleName === other.middleName
    );
  }
}
