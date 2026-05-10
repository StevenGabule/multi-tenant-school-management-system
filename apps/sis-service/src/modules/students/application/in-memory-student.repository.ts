import { Student } from '../domain/entities/student.entity';
import {
  StudentListFilter,
  StudentRepository,
} from '../domain/repositories/student.repository';
import { StudentId } from '../domain/value-objects/student-id.vo';

/**
 * In-memory implementation of StudentRepository. Used by application-
 * layer tests to exercise use cases WITHOUT spinning up Postgres. The
 * existence of this implementation is the proof that the domain layer
 * doesn't depend on Prisma — if it did, this stub couldn't satisfy the
 * interface.
 *
 * Lives in /application not /infrastructure because it's a test-only
 * dependency for the application layer; it never ships to production.
 */
export class InMemoryStudentRepository implements StudentRepository {
  private readonly byId = new Map<string, Student>();

  async findById(id: StudentId): Promise<Student | null> {
    return this.byId.get(id.value) ?? null;
  }

  async findByExternalId(externalId: string): Promise<Student | null> {
    for (const s of this.byId.values()) {
      if (s.externalId === externalId) return s;
    }
    return null;
  }

  async list(filter: StudentListFilter = {}): Promise<Student[]> {
    let out = Array.from(this.byId.values());
    if (!filter.includeDeleted) out = out.filter((s) => !s.isDeleted());
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      out = out.filter(
        (s) =>
          s.name.firstName.toLowerCase().includes(needle) ||
          s.name.lastName.toLowerCase().includes(needle),
      );
    }
    out.sort((a, b) => {
      const byLast = a.name.lastName.localeCompare(b.name.lastName);
      return byLast !== 0
        ? byLast
        : a.name.firstName.localeCompare(b.name.firstName);
    });
    return out.slice(0, Math.min(filter.limit ?? 50, 200));
  }

  async save(student: Student): Promise<void> {
    this.byId.set(student.id.value, student);
  }

  /** Test helper: total count regardless of soft-delete state. */
  size(): number {
    return this.byId.size;
  }
}
