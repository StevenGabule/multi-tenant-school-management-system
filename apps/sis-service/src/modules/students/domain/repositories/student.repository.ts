import { Student } from '../entities/student.entity';
import { StudentId } from '../value-objects/student-id.vo';

/**
 * The repository is defined by the DOMAIN — application services depend
 * on this interface, never on the Prisma implementation. The
 * infrastructure layer provides the concrete implementation.
 *
 * This dependency direction (domain ← infrastructure) is what makes the
 * application layer unit-testable without a database (an in-memory
 * implementation suffices) and what would let us swap Prisma for raw SQL
 * (or any other persistence) by writing one new file in infrastructure.
 *
 * `STUDENT_REPOSITORY` is the DI token. Application providers inject it
 * via `@Inject(STUDENT_REPOSITORY)` so the binding stays interface-only.
 */
export const STUDENT_REPOSITORY = Symbol('STUDENT_REPOSITORY');

export interface StudentListFilter {
  /** Whether to include soft-deleted records. Default: false. */
  includeDeleted?: boolean;
  /** Substring match against firstName/lastName (case-insensitive). */
  search?: string;
  /** Cap on results returned. Default: 50, max 200 (validated at boundary). */
  limit?: number;
}

export interface StudentRepository {
  findById(id: StudentId): Promise<Student | null>;
  findByExternalId(externalId: string): Promise<Student | null>;
  list(filter?: StudentListFilter): Promise<Student[]>;
  /** Insert if new, update if existing (UPSERT semantics by id). */
  save(student: Student): Promise<void>;
}
