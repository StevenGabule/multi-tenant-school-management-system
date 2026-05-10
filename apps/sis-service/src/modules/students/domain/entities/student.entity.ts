import { InvariantViolation } from '../errors';
import { DateOfBirth } from '../value-objects/date-of-birth.vo';
import { Email } from '../value-objects/email.vo';
import { FullName } from '../value-objects/full-name.vo';
import { Phone } from '../value-objects/phone.vo';
import { StudentId } from '../value-objects/student-id.vo';

/**
 * Snapshot used by the mapper to hydrate a Student from a Prisma row.
 * Only the infrastructure layer should construct this.
 */
export interface StudentSnapshot {
  id: string;
  tenantId: string;
  externalId: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string; // ISO YYYY-MM-DD
  email: string | null;
  phone: string | null;
  gender: string | null;
  enrolledAt: Date | null;
  withdrawnAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStudentInput {
  tenantId: string;
  name: FullName;
  dateOfBirth: DateOfBirth;
  externalId?: string | null;
  email?: Email | null;
  phone?: Phone | null;
  gender?: string | null;
}

/**
 * Student aggregate root. Holds value objects (never primitives) for
 * fields that have invariants. Mutating methods enforce the rules of
 * the domain — the only way to get a Student into a "created but invalid"
 * state would be to bypass the constructor, which is private.
 *
 * Aggregate boundary: a Student does NOT contain its enrollments or its
 * Guardian list inline. Those are separate aggregates referenced by ID.
 * This keeps the consistency boundary small (no "student + 12 years of
 * grades + every guardian relationship" loaded for every operation).
 */
export class Student {
  private constructor(
    public readonly id: StudentId,
    public readonly tenantId: string,
    private _externalId: string | null,
    private _name: FullName,
    public readonly dateOfBirth: DateOfBirth,
    private _email: Email | null,
    private _phone: Phone | null,
    private _gender: string | null,
    private _enrolledAt: Date | null,
    private _withdrawnAt: Date | null,
    private _deletedAt: Date | null,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Create a brand-new Student. Generates a fresh UUID. */
  static create(input: CreateStudentInput): Student {
    const id = StudentId.from(crypto.randomUUID());
    const now = new Date();
    return new Student(
      id,
      input.tenantId,
      input.externalId?.trim() || null,
      input.name,
      input.dateOfBirth,
      input.email ?? null,
      input.phone ?? null,
      input.gender?.trim() || null,
      null,
      null,
      null,
      now,
      now,
    );
  }

  /** Hydrate from persistence. ONLY infrastructure should call this. */
  static reconstitute(snap: StudentSnapshot): Student {
    return new Student(
      StudentId.fromTrusted(snap.id),
      snap.tenantId,
      snap.externalId,
      FullName.of(snap.firstName, snap.lastName, snap.middleName),
      DateOfBirth.from(snap.dateOfBirth),
      snap.email ? Email.from(snap.email) : null,
      snap.phone ? Phone.from(snap.phone) : null,
      snap.gender,
      snap.enrolledAt,
      snap.withdrawnAt,
      snap.deletedAt,
      snap.createdAt,
      snap.updatedAt,
    );
  }

  // ─── getters (immutable view of internal state) ───────────────────────
  get name(): FullName {
    return this._name;
  }
  get email(): Email | null {
    return this._email;
  }
  get phone(): Phone | null {
    return this._phone;
  }
  get gender(): string | null {
    return this._gender;
  }
  get externalId(): string | null {
    return this._externalId;
  }
  get enrolledAt(): Date | null {
    return this._enrolledAt;
  }
  get withdrawnAt(): Date | null {
    return this._withdrawnAt;
  }
  get deletedAt(): Date | null {
    return this._deletedAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  isDeleted(): boolean {
    return this._deletedAt !== null;
  }

  // ─── behaviors (mutating, invariant-checked) ──────────────────────────

  rename(newName: FullName): void {
    this.assertNotDeleted('rename');
    if (this._name.equals(newName)) return; // no-op
    this._name = newName;
    this.touch();
  }

  updateContact(input: { email?: Email | null; phone?: Phone | null }): void {
    this.assertNotDeleted('updateContact');
    if (input.email !== undefined) this._email = input.email;
    if (input.phone !== undefined) this._phone = input.phone;
    this.touch();
  }

  recordExternalId(externalId: string | null): void {
    this.assertNotDeleted('recordExternalId');
    const trimmed = externalId?.trim() || null;
    if (this._externalId === trimmed) return;
    this._externalId = trimmed;
    this.touch();
  }

  /** Idempotent: subsequent calls keep the original deletedAt timestamp. */
  softDelete(at: Date = new Date()): void {
    if (this._deletedAt !== null) return;
    this._deletedAt = at;
    this.touch(at);
  }

  /** Reactivate a previously soft-deleted student. */
  restore(): void {
    if (this._deletedAt === null) return;
    this._deletedAt = null;
    this.touch();
  }

  /** Snapshot for the mapper to write to persistence. */
  toSnapshot(): StudentSnapshot {
    return {
      id: this.id.value,
      tenantId: this.tenantId,
      externalId: this._externalId,
      firstName: this._name.firstName,
      middleName: this._name.middleName,
      lastName: this._name.lastName,
      dateOfBirth: this.dateOfBirth.toISODate(),
      email: this._email?.value ?? null,
      phone: this._phone?.value ?? null,
      gender: this._gender,
      enrolledAt: this._enrolledAt,
      withdrawnAt: this._withdrawnAt,
      deletedAt: this._deletedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  // ─── private invariant guards ─────────────────────────────────────────

  private assertNotDeleted(operation: string): void {
    if (this._deletedAt !== null) {
      throw new InvariantViolation(
        `Cannot ${operation} on a deleted Student (id=${this.id.value})`,
      );
    }
  }

  private touch(at: Date = new Date()): void {
    this._updatedAt = at;
  }
}
