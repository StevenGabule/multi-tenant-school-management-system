# ADR-0008: Clean architecture layering for sis-service (and every domain service after)

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Milestone 1.3 adds the first real domain service (`sis-service`, Student
Information System). The placeholder `health_check` table from milestone
1.0 didn't have business rules; SIS does — student names have invariants
(non-empty, length cap), dates of birth must be in the past, soft-delete
is idempotent, etc.

This is the first opportunity to commit to an architectural style. Two
plausible options:

1. **NestJS-default style.** Controllers call PrismaService directly.
   Module/service/controller is the only seam. Returns Prisma models as
   API responses.
2. **Clean architecture (Hexagonal/Ports-and-Adapters/DDD-lite).**
   Four layers — controllers, application, domain, infrastructure — with
   strict dependency direction (domain ← infrastructure). Domain entities
   are separate from Prisma models. Repositories are interfaces in the
   domain layer; the Prisma implementation is an infrastructure detail.

The choice is consequential. Every service in milestones 1.4+ will inherit
this pattern — six more services in Phase 1 alone, fifteen-plus by Phase 3.
A wrong choice now is expensive to undo because it shapes how every
domain rule gets written.

## Decision

**We adopt the four-layer clean architecture pattern for sis-service and
every subsequent domain service.**

```
apps/<service>/src/modules/<context>/
├── controllers/        — HTTP surface; thin; Zod-validated DTOs
├── application/        — use cases; ONE class per use case; injects repo by interface
├── domain/             — entities, value objects, repository interfaces, errors
│   ├── entities/
│   ├── value-objects/
│   ├── repositories/   — INTERFACES live here
│   └── errors.ts
└── infrastructure/     — Prisma repository impl, mappers, external adapters
```

Specific rules:

1. **Domain has zero framework imports.** No `@nestjs/*`, no `@prisma/*`.
   Plain TypeScript. Verifiable by `grep` and (Phase 2) by an ESLint rule.

2. **Repository interface lives in the domain.** Application services
   inject `@Inject(STUDENT_REPOSITORY)` (a Symbol). The infrastructure
   layer provides `{ provide: STUDENT_REPOSITORY, useExisting: PrismaStudentRepository }`.
   Tests swap in `InMemoryStudentRepository` (also under /application).

3. **Domain entity ≠ Prisma model.** `Student` is a separate class with
   value objects for fields, behaviors as methods, and invariants in
   `assertNotDeleted()`-style guards. The infrastructure mapper is the
   ONLY place where the two types meet — `toSnapshot()` / `reconstitute()`.

4. **Value objects for fields with invariants.** Identifier types use a
   `__brand` discriminator for nominal type safety (`StudentId` ≠
   `GuardianId` even though both wrap a UUID at runtime). Names, dates,
   emails, phones get value-object treatment; "primitives" stay primitive.

5. **One class per use case.** `CreateStudentUseCase`, `FindStudentByIdUseCase`,
   etc. — Single Responsibility taken seriously. The application layer
   never reaches across use cases; orchestration belongs in sagas
   (milestone 1.5), not other use cases.

6. **The presenter pattern.** `toStudentResponse(student)` translates the
   domain entity to the wire shape. Separate from `toSnapshot()` (which
   is for persistence). This keeps API contract changes isolated to the
   presenter file — renames in the domain don't silently leak through HTTP.

7. **Soft-delete uses the deletedAt column WITHOUT an `active_only`
   RESTRICTIVE RLS policy.** Lesson from milestone 1.1: RESTRICTIVE
   FOR SELECT also fires on UPDATE/INSERT, blocking the obvious
   `UPDATE deletedAt = NOW()` soft-delete pattern. We accept the
   tradeoff: filtering happens at the repository layer (`WHERE deletedAt
   IS NULL`) instead of at the database. RLS still enforces tenant
   isolation, which is the security floor. Soft-delete invisibility is
   a nice-to-have we can reintroduce in Phase 2 via a `SECURITY DEFINER`
   function that bypasses the policy.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **NestJS-default (controllers → Prisma)** | Less code; faster to a working endpoint; familiar to most NestJS tutorials | Schema becomes API contract (rename a column → break every client); business logic spreads across controllers and miscellaneous services; tests require a real DB or heavy Prisma mocking; refactoring Prisma away is a rewrite | Doesn't survive past ~30 controllers; the project plans 50+ |
| **Clean architecture (chosen)** | Domain rules in one place; test pyramid is real (unit / app / integration); Prisma is replaceable; entity-vs-model separation insulates the API contract; ~20% more code | Up-front cost; one more "layer" to navigate; every controller has 4 files behind it instead of 1 | n/a — pays back at the third domain change |
| **Hexagonal with explicit ports + adapters folders** | Most-rigorous version of clean architecture | Ceremonial; the port/adapter terminology adds a vocabulary learning cost; we'd be the only NestJS shop using it | Over-engineering for a one-engineer project; clean-architecture as written here gets ~85% of the benefit |
| **CQRS as the default split** | Clean read-vs-write separation; high-fanout reads naturally optimized | Half the milestone-1.3 use cases are reads (find/list); CQRS would mean two parallel directory structures from day one; speculative complexity | We adopt CQRS only where evidence demands it — see ADR-XXXX (future) when the gradebook arrives in milestone 1.4+ |

## Consequences

**Positive:**

- The test pyramid (35 unit + 11 application + 5 integration + 6
  cross-tenant safety net = 57 in milestone 1.3) is a direct consequence
  of the layering. Without the repository interface, application tests
  would need a real Postgres. Without value objects, half the unit
  tests would need to test "did the controller validate this?" instead
  of "does the domain refuse this?".
- The `InMemoryStudentRepository` exists. Its existence is proof that
  the application doesn't depend on Prisma — if it did, this stub
  couldn't satisfy the interface.
- Renaming a column in the Prisma schema (e.g., `firstName` → `givenName`)
  requires updating ONLY the mapper. The wire contract stays stable
  (because the presenter uses the domain entity, not the Prisma row).
- The `DomainExceptionFilter` is a clean seam: `InvariantViolation`
  becomes `400 Bad Request`, `StudentNotFound` becomes `404 Not Found`.
  Without the domain layer there'd be nothing to map FROM.

**Negative / costs:**

- Every endpoint touches 4 files (controller, use case, entity, repository
  + mapper). Junior engineers reading the code for the first time will
  ask "why does adding a field require five edits?". The answer is in
  this ADR; needs to be linked from the codebase README.
- The `StudentSnapshot` interface duplicates the Prisma row shape
  partially. Drift risk: change the schema, forget to update the
  snapshot, mapper still compiles, runtime breaks. Mitigation: integration
  test (Step 9 of milestone 1.3) catches this within seconds.
- Value objects add small ceremony: `FullName.of(first, last)` instead
  of `{ first, last }`. The pay-off is centralized formatting and
  validation; pay-as-you-go on services without complex name semantics
  may not be worth it.

**Risks:**

- Future engineer adds business logic to a controller for "convenience"
  — bypasses the use case layer. Mitigation: code review + one ESLint
  rule (Phase 2) banning Prisma imports from controllers.
- The `__brand` nominal-typing trick on value objects is unfamiliar
  TypeScript. Engineers may not understand why `StudentId` can't be
  passed where `GuardianId` is expected. Mitigation: this ADR + JSDoc
  comments on each VO + a one-sentence README in `domain/value-objects/`.
- Soft-delete-via-WHERE clause leaks if anyone bypasses the repository.
  In practice all code goes through the repository, but a future raw
  SQL query in some adhoc admin endpoint could miss the filter.
  Mitigation: keep "raw SQL touching tenant tables" off the table as a
  practice; if absolutely needed, add `WHERE deletedAt IS NULL` and a
  comment explaining why.

**Follow-up work this enables / forces:**

- Milestone 1.4 (outbox + events) adds domain events to `Student.create()`
  and other mutating methods. The aggregate emits an event; the
  infrastructure transactional-outbox writes it alongside the row. The
  domain stays unaware of Kafka or anything else.
- Milestone 1.5 (saga) orchestrates use cases across services. The
  enrollment saga calls `CreateStudentUseCase`, `AssignToSectionUseCase`,
  etc. — each compensable individually. The clean-architecture seams
  make compensation actions trivial to define.
- Milestone 1.7 (BFFs) pulls multi-service responses through. The
  Student entity is what BFFs receive (via in-process or gRPC); the
  presenter shapes it for the parent/teacher/admin client.
- Phase 2 ESLint rules: domain layer can't import from `@nestjs/*` or
  `@prisma/*`. Controllers can't import from `@prisma/*`. Use cases
  can't construct repository implementations directly.

## References

- Robert C. Martin, *Clean Architecture* (2017) — the four-layer concentric model.
- Eric Evans, *Domain-Driven Design* (2003) — bounded context, aggregates, value objects.
- Vaughn Vernon, *Implementing Domain-Driven Design* (2013) — practical patterns.
- Khalil Stemmler's blog (`khalilstemmler.com`) — pragmatic clean-architecture-in-TypeScript.
- This repo:
  - `apps/sis-service/src/modules/students/` — the canonical implementation
  - `apps/sis-service/src/modules/students/application/in-memory-student.repository.ts` — proof the layering works
  - `apps/sis-service/src/modules/students/infrastructure/student.integration.spec.ts` — drift catcher
  - `apps/sis-service/src/common/domain-exception.filter.ts` — the seam between domain language and HTTP
- Phase 1.3 milestone: [`../phase-1/03-sis-first-service.md`](../phase-1/03-sis-first-service.md)
- Related: [ADR-0005](0005-rls-tenant-isolation.md) (RLS — also enforced here, no `active_only`)
