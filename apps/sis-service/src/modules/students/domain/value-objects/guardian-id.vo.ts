import { InvariantViolation } from '../errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Brand-distinct from StudentId. Mostly here to demonstrate the pattern;
 * GuardianId is consumed by the GuardianLink use cases (milestone 1.4+).
 */
export class GuardianId {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly __brand: 'GuardianId' = 'GuardianId';

  private constructor(public readonly value: string) {}

  static from(raw: string): GuardianId {
    if (!UUID_RE.test(raw)) {
      throw new InvariantViolation(`Invalid GuardianId UUID: "${raw}"`);
    }
    return new GuardianId(raw.toLowerCase());
  }

  static fromTrusted(raw: string): GuardianId {
    return new GuardianId(raw);
  }

  equals(other: GuardianId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
