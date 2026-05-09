# Phase 1.3 — First domain service: SIS (Student Information System)

> **Concepts:** Domain-Driven Design bounded context, clean architecture (controllers / application / domain / infrastructure), repository pattern, aggregate roots and invariants, value objects, DTO validation, soft-delete under RLS, the Prisma-model-vs-domain-entity separation
> **Estimated effort:** 3 weekends — this is where architectural discipline pays off or doesn't
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 1.0–1.2 complete (RLS works, registry resolves tenants, cross-tenant test passes)
> - Read [`../../documentation.md`](../../documentation.md) §1 (service #3 Student Information), §8 (NestJS + Prisma patterns)
> - Read at least one chapter of *Domain-Driven Design Distilled* (Vaughn Vernon) or the relevant DDD subset of any senior engineering reference

---

## What you'll learn

- The Domain-Driven Design notion of a **bounded context** and how it applies in code, not just in diagrams.
- **Clean architecture** layers — what belongs in controllers, application services, domain entities, and infrastructure — and why this separation pays off when (not if) you swap an infrastructure dependency.
- The **repository pattern** as a domain-defined interface, with an infrastructure-defined implementation. Why this is the boundary that lets you unit-test domain logic without spinning up Postgres.
- **Aggregate roots** as the unit of consistency: which entities cluster, which references are ID-only, where invariants are enforced.
- **Value objects** for identifiers (`StudentId`), names (`FullName`), and dates (`DateOfBirth`) — what they earn you and when they're overkill.
- **DTO validation** at the API boundary using Zod (or class-validator) — the single best line of defense against bad input.
- The interaction of soft-delete with RLS, and why a `RESTRICTIVE` policy beats a `WHERE deleted_at IS NULL` filter you'll forget.
- The DDD principle that **the domain entity is not the database row** — and the test that proves the separation is real.

---

## Why this matters (senior perspective)

Most production NestJS codebases have controllers calling Prisma directly, returning Prisma model instances as API responses. It's fast, expedient, and produces software that becomes unmaintainable around the 30-controller mark.

The failures aren't subtle:

- **Schema becomes API contract.** A `Student.email` field renamed in `schema.prisma` silently breaks every client. There's no insulating layer.
- **Business logic spreads.** "A student cannot be enrolled in a section without an active enrollment" gets enforced in three controllers, two background jobs, and one badly-named utility. Each enforcement disagrees subtly.
- **Tests become integration-only.** You cannot unit-test "what happens when a student is over 21" without spinning up Postgres because your `Student` *is* the Prisma model.
- **Refactors become impossible.** Replacing Prisma with raw SQL or another ORM means rewriting every controller. The dependency is everywhere.

The clean-architecture discipline costs ~20% more code on day one and pays back 10× by the third domain change. The senior posture: **infrastructure is replaceable; the domain is the asset.** Protect the domain by making infrastructure consume an interface the domain owns.

The second senior moment is choosing where to draw the **aggregate boundary**. A `Student` aggregate that contains all enrollments forever is a transactional bottleneck waiting to happen. A `Student` aggregate that's just demographics, with `Enrollment` as a separate aggregate referenced by ID, is far more scalable but requires you to give up "transactional consistency between student and their enrollments." That tradeoff is the kind of decision senior engineers articulate; junior engineers default-accept whatever Prisma generates.

---

## Hands-on plan

### Step 1 — Generate the SIS service and lay out the layers

1. `nx g @nx/nest:app sis-service`.
2. Create the directory layout inside `apps/sis-service/src/`:

```
sis-service/src/
├── main.ts
├── app.module.ts
├── modules/
│   └── students/
│       ├── students.module.ts
│       ├── controllers/        ← thin: parse DTO, call use case, return DTO
│       │   └── students.controller.ts
│       ├── application/         ← use cases / application services
│       │   ├── create-student.use-case.ts
│       │   ├── update-student.use-case.ts
│       │   ├── soft-delete-student.use-case.ts
│       │   └── find-student.query.ts
│       ├── domain/              ← pure domain. Zero framework imports.
│       │   ├── entities/
│       │   │   ├── student.entity.ts
│       │   │   └── guardian.entity.ts
│       │   ├── value-objects/
│       │   │   ├── student-id.vo.ts
│       │   │   ├── full-name.vo.ts
│       │   │   └── date-of-birth.vo.ts
│       │   ├── repositories/    ← INTERFACES owned by the domain
│       │   │   └── student.repository.ts
│       │   └── events/
│       │       ├── student-created.event.ts
│       │       └── student-soft-deleted.event.ts
│       └── infrastructure/      ← Prisma, mappers, repository impls
│           ├── prisma-student.repository.ts
│           └── student.mapper.ts
└── prisma/
    └── schema.prisma
```

The directory structure is the contract. If `domain/` ever imports from `@prisma/client` or `@nestjs/common`, the structure has been violated.

### Step 2 — Define the persistence schema

Add to `schema.prisma`:

```
model Student {
  id           String    @id @default(uuid()) @db.Uuid
  tenantId     String    @db.Uuid
  externalId   String?                                 // school-issued ID; unique per tenant
  firstName    String
  lastName     String
  dateOfBirth  DateTime  @db.Date
  email        String?
  phone        String?
  gender       String?
  enrolledAt   DateTime?
  withdrawnAt  DateTime?
  deletedAt    DateTime?                               // soft delete
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  guardians    GuardianLink[]

  @@unique([tenantId, externalId])
  @@index([tenantId, lastName, firstName])
}

model Guardian {
  id          String  @id @default(uuid()) @db.Uuid
  tenantId    String  @db.Uuid
  firstName   String
  lastName    String
  email       String?
  phone       String?
  relationship String                                   // "parent", "legal_guardian", "emergency"
  students    GuardianLink[]
  deletedAt   DateTime?
  createdAt   DateTime @default(now())
}

model GuardianLink {
  studentId  String @db.Uuid
  guardianId String @db.Uuid
  isPrimary  Boolean
  student    Student  @relation(fields: [studentId], references: [id])
  guardian   Guardian @relation(fields: [guardianId], references: [id])

  @@id([studentId, guardianId])
}
```

In the migration SQL (hand-edited or amended), enable RLS on every table including the link table:

```sql
ALTER TABLE "Student" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Student" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Student"
  USING ("tenantId" = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY active_only ON "Student" AS RESTRICTIVE
  FOR SELECT USING ("deletedAt" IS NULL);

-- Same for Guardian and GuardianLink (the link inherits via both endpoints).
```

The `RESTRICTIVE active_only` policy is the trick that makes soft-delete safe under RLS. With it, no query — including ones that forget the `WHERE deleted_at IS NULL` clause — can see soft-deleted rows. You can still surface deleted records via a privileged admin role with `BYPASSRLS`, but normal queries are clean by default.

### Step 3 — Define the domain entity (separate from the Prisma model)

`student.entity.ts` is plain TypeScript. **Zero imports from `@prisma/client`, `@nestjs/*`, or any framework.**

```typescript
export class Student {
  private constructor(
    public readonly id: StudentId,
    public readonly tenantId: TenantId,
    public readonly externalId: string | null,
    public name: FullName,
    public readonly dateOfBirth: DateOfBirth,
    public email: Email | null,
    public phone: Phone | null,
    public enrolledAt: Date | null,
    public withdrawnAt: Date | null,
    private deletedAt: Date | null,
  ) {}

  static create(params: { ... }): Student {
    // invariants enforced here:
    // - dateOfBirth must be in the past
    // - if externalId provided, must match school-id format
    // - email format validated by the value object
    return new Student(...);
  }

  rename(newName: FullName) {
    if (this.deletedAt) throw new DomainError('Cannot rename deleted student');
    this.name = newName;
  }

  softDelete(at: Date = new Date()) {
    if (this.deletedAt) return;
    this.deletedAt = at;
  }

  isDeleted(): boolean {
    return this.deletedAt !== null;
  }
}
```

The constructor is private. All construction goes through `Student.create(...)` (for new students) or `Student.reconstitute(...)` (for hydrating from persistence). Invariants live in those factories. The entity *cannot* be in an invalid state.

### Step 4 — Value objects where they earn their keep

Three value objects are worth the boilerplate:

- **`StudentId`** — wraps a UUID, enforces format, prevents passing a `GuardianId` where a `StudentId` was expected (TypeScript brand types).
- **`FullName`** — first + last (+ middle, suffix). Centralizes display formatting (`student.name.toString() === "Last, First"` consistently).
- **`DateOfBirth`** — wraps a Date, enforces "in the past," provides `ageInYears(now)`.

Don't over-do it. `Email` and `Phone` are nice-to-haves; you can use plain validated strings if you prefer. The test: does the value object prevent a class of bugs, or is it ceremony? If the answer is ceremony, drop it.

### Step 5 — Repository interface in the domain layer

```typescript
// domain/repositories/student.repository.ts
export interface StudentRepository {
  findById(id: StudentId): Promise<Student | null>;
  findByExternalId(externalId: string): Promise<Student | null>;
  save(student: Student): Promise<void>;
  list(filter: StudentFilter, page: Page): Promise<PagedResult<Student>>;
}
```

The interface is owned by the domain. Application services depend on this interface, not on Prisma.

### Step 6 — Repository implementation in the infrastructure layer

```typescript
// infrastructure/prisma-student.repository.ts
@Injectable()
export class PrismaStudentRepository implements StudentRepository {
  constructor(private prisma: PrismaService) {}

  async findById(id: StudentId): Promise<Student | null> {
    const row = await this.prisma.student.findUnique({ where: { id: id.value } });
    return row ? StudentMapper.toDomain(row) : null;
  }

  async save(student: Student): Promise<void> {
    const data = StudentMapper.toPersistence(student);
    await this.prisma.student.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
  }
  // ...
}
```

The `StudentMapper` translates between the Prisma row shape and the domain entity. It's the only place `@prisma/client` types meet domain types. Keep it pure functions; it's trivial to unit-test.

Wire the implementation in the module:

```typescript
@Module({
  providers: [
    { provide: 'StudentRepository', useClass: PrismaStudentRepository },
    CreateStudentUseCase,
    // ...
  ],
})
export class StudentsModule {}
```

Application services receive the repository by interface (`@Inject('StudentRepository') private repo: StudentRepository`), never by class. Now `CreateStudentUseCase` can be unit-tested with an `InMemoryStudentRepository`.

### Step 7 — Application services (use cases)

Each use case is one class with one method (`execute`). Single Responsibility taken seriously.

```typescript
@Injectable()
export class CreateStudentUseCase {
  constructor(
    @Inject('StudentRepository') private repo: StudentRepository,
    private cls: ClsService,
    private events: DomainEventPublisher,
  ) {}

  async execute(input: CreateStudentInput): Promise<StudentId> {
    const tenantId = TenantId.from(this.cls.get('tenantId'));
    const student = Student.create({
      tenantId,
      externalId: input.externalId,
      name: FullName.of(input.firstName, input.lastName),
      dateOfBirth: DateOfBirth.from(input.dateOfBirth),
      email: input.email ? Email.from(input.email) : null,
    });
    await this.repo.save(student);
    await this.events.publish(new StudentCreatedEvent(student.id, tenantId));
    return student.id;
  }
}
```

The use case is the only place that knows the order: validate, construct entity, persist, emit event. Controllers don't know it; entities don't know it.

### Step 8 — DTOs and validation at the boundary

In the controller, accept a `CreateStudentDto` validated by Zod (or class-validator). The DTO is *not* the domain entity. Map between them in the use case input.

```typescript
// dtos/create-student.dto.ts
export const CreateStudentDtoSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  externalId: z.string().optional(),
  email: z.string().email().optional(),
});
export type CreateStudentDto = z.infer<typeof CreateStudentDtoSchema>;
```

A NestJS pipe parses the body against the schema. Bad input gets a 400 with a structured error before the use case is ever called. Validation is **always at the boundary** — never inside use cases (which trust their inputs because the boundary already validated).

### Step 9 — Soft-delete that's actually safe

The `RESTRICTIVE active_only` RLS policy from step 2 prevents normal queries from seeing deleted students. The use case for soft-delete:

```typescript
async execute(input: SoftDeleteStudentInput): Promise<void> {
  const student = await this.repo.findById(input.id);
  if (!student) throw new NotFoundError('Student not found');
  student.softDelete();
  await this.repo.save(student);
  await this.events.publish(new StudentSoftDeletedEvent(student.id));
}
```

The interaction with RLS: when `softDelete()` updates `deletedAt`, the same UPDATE moves the row out of the active set. Future `findById` calls return null (because the restrictive policy hides the row). To restore, you need a privileged path that bypasses the restrictive policy — either a database role with `BYPASSRLS` or a special admin endpoint. Document this; it's an admin escape valve, not a normal feature.

### Step 10 — Tests at every layer

This is the test pyramid clean architecture pays for:

- **Unit (fastest, most numerous):** test domain entities and value objects with no infrastructure. `Student.create({ dateOfBirth: <future> })` should throw. `FullName.of('', '')` should throw.
- **Application (medium):** test use cases against an `InMemoryStudentRepository`. No database. No NestJS bootstrap. Pure logic.
- **Integration (fewest, slowest):** test repository implementations against a real Postgres (Testcontainers). Verify RLS behavior. Verify soft-delete is invisible.
- **End-to-end:** the cross-tenant test from milestone 1.1 is extended to students. Two tenants, each creates students, neither sees the other's.

The pyramid is not aspirational — write the unit tests first. Their existence is what makes refactoring possible.

### Step 11 — Write the ADR

[`adr/0007-clean-architecture-layering.md`](../adr/) — defending the four-layer split, the cost (~20% more code), and the test pyramid it enables. Include the alternative considered ("controller → Prisma directly") and why it's rejected for a service expected to live for years.

---

## Definition of done

- [ ] `sis-service` runs as a separate NestJS app deployable to kind.
- [ ] Directory layers (`controllers/`, `application/`, `domain/`, `infrastructure/`) are enforced — `domain/` has zero framework imports.
- [ ] `Student` and `Guardian` Prisma models exist with `tenantId NOT NULL`, RLS enabled, restrictive `active_only` policy.
- [ ] Domain entity `Student` is a separate class from the Prisma model; a `StudentMapper` translates.
- [ ] Three value objects (`StudentId`, `FullName`, `DateOfBirth`) — each justifying its existence by preventing a class of bugs.
- [ ] Repository interface in `domain/`; Prisma implementation in `infrastructure/`; injection by interface.
- [ ] Application services (`CreateStudentUseCase`, etc.) consume the repository interface; testable without Postgres.
- [ ] DTOs validated with Zod (or class-validator) at the controller boundary.
- [ ] Soft-delete works; deleted students invisible to normal queries; documented admin path to restore.
- [ ] Test pyramid:
  - [ ] Unit tests on domain entity + value objects (≥ 10 tests).
  - [ ] Application tests with in-memory repository (≥ 5 use case tests).
  - [ ] Integration tests against real Postgres for the repository (≥ 3 tests).
  - [ ] Cross-tenant integration test extended to students.
- [ ] OpenAPI/Swagger docs generated and visible at `/api`.
- [ ] ADR-0007 (clean architecture) written.

---

## Common pitfalls

1. **Returning the Prisma model from the controller.** The day you rename a column, every client breaks. Map to a DTO at the boundary, every time.
2. **Domain entity importing Prisma types.** The dependency direction is inverted. Domain should not know what database is used.
3. **Use case calling Prisma directly.** Now you can't unit-test the use case without Postgres.
4. **Repository interface in `infrastructure/` instead of `domain/`.** The dependency arrow now points from domain to infrastructure — the opposite of what you want.
5. **Skipping the mapper.** "Just pass the Prisma object through" is the gateway drug to "just put business logic in the controller."
6. **Anaemic entities.** A `Student` class with only public getters/setters and zero behaviour is *not* a domain entity — it's a DTO with a fancier name. Behaviour (invariants, state transitions) is what the entity is *for*.
7. **Value objects for everything.** A `Phone` value object that wraps a string and validates it with one regex is fine. A `Phone` value object with 200 lines and three subclasses is over-engineering.
8. **DTOs and entities sharing types.** They will diverge (the API contract is stable; the domain is not). Keep them separate from day one even when they look identical.
9. **Forgetting `tenantId` on the entity.** The `tenantId` column is on the database row but not on the domain entity — now business logic that should care about tenant cannot. Include it.
10. **Soft-delete via `WHERE deleted_at IS NULL` everywhere.** You will forget the clause. Use the RESTRICTIVE RLS policy.

---

## Stretch goals (optional rabbit holes)

- **Add domain events that publish when a Student is created or soft-deleted.** Wire them into a synchronous in-memory event bus first; milestone 1.4 graduates them to the outbox.
- **Implement specifications (or query objects)** for complex `find` operations: `findStudentsByGradeLevel`, `findStudentsBornBefore`. The Specification pattern beats endless `find*` repository methods.
- **Add CQRS lite:** separate `Query` interfaces (read-optimized, can hit Prisma directly) from the repository (write-side). The trade is more code for cleaner read paths.
- **Generate the OpenAPI spec from Zod schemas** using `@anatine/zod-openapi` or similar. The DTO is now both validation and documentation.
- **Property-based testing** of the `Student.create` invariants using `fast-check`. Generate random inputs; assert invariants hold. You'll find an edge case you missed.
- **Implement the `Guardian` domain in full**, including the `GuardianLink` aggregate and the "primary guardian per student" invariant. Notice how the aggregate boundary decision affects code shape.
- **Read Eric Evans' *Domain-Driven Design* (Blue Book)** chapters on Bounded Context and Aggregates. Compare what you've built to what he describes.

---

## Reflection questions

1. **Why is the repository interface in `domain/` rather than `infrastructure/`?** What dependency arrow would be wrong if it were the other way?
2. **You added a `FullName` value object. What bug does its existence prevent that a `string` would not?** If your answer is "nothing concrete," reconsider whether it earns its keep.
3. **The `Student` domain entity has a `tenantId` field, even though RLS would enforce isolation without it. Why include it?** What use case becomes possible because the entity carries its tenant?
4. **What's in `Student` (the aggregate) and what's referenced by ID instead?** Describe the consistency boundary you've drawn — what invariants are atomic, and what are eventually consistent?
5. **Could you replace Prisma with raw SQL tomorrow? Walk through what would change.** If the answer touches your controllers, your layering is wrong.
6. **The RLS `RESTRICTIVE active_only` policy hides soft-deleted rows. How would an admin restore a soft-deleted student?** Document the privileged path and its audit posture.
7. **What test would catch the bug "we returned tenant A's student data via a list endpoint that bypassed the use case"?** Write that test today; do not wait for the bug.

---

## References (curated)

- **Project documentation:** [`../../documentation.md`](../../documentation.md) §1 (SIS Core), §8 (NestJS + Prisma patterns).
- **Eric Evans, *Domain-Driven Design***: Bounded Context (Ch. 14), Aggregates (Ch. 6), Value Objects (Ch. 5).
- **Vaughn Vernon, *Implementing Domain-Driven Design*** — practical patterns; Chapter 10 (Aggregates) is essential.
- **Robert C. Martin, *Clean Architecture***: the four-layer concentric model.
- **Khalil Stemmler's blog (`khalilstemmler.com`)**: clean-architecture-in-TypeScript articles. Pragmatic and TypeScript-specific.
- **Microsoft eShopOnContainers reference**: clean-architecture in a real microservice; transferable concepts even though it's .NET.

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) milestone 1.3 to `Done`. Move to milestone 1.4 (Outbox + event consumer). The first cross-service event is about to flow.
