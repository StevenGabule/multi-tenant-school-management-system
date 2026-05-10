import { InvariantViolation } from '../errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * UUID identifier for a Student aggregate. The `__brand` discriminator
 * makes this nominally distinct from GuardianId / TenantId / a plain
 * string — TypeScript will reject `function takesStudent(id: GuardianId)`
 * even though both wrap the same UUID shape.
 *
 * Construct via:
 *   StudentId.from(externalUuid)         — validates format
 *   StudentId.fromTrusted(uuidFromDb)    — skips validation, for DB hydration
 */
export class StudentId {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly __brand: 'StudentId' = 'StudentId';

  private constructor(public readonly value: string) {}

  static from(raw: string): StudentId {
    if (!UUID_RE.test(raw)) {
      throw new InvariantViolation(`Invalid StudentId UUID: "${raw}"`);
    }
    return new StudentId(raw.toLowerCase());
  }

  /** Bypasses validation — only for hydrating from a trusted source (DB). */
  static fromTrusted(raw: string): StudentId {
    return new StudentId(raw);
  }

  equals(other: StudentId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
