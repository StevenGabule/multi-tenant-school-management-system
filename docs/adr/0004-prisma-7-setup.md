# ADR-0004: Prisma 7 setup with prisma.config.ts and driver adapter

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

Prisma 7 introduced two backwards-incompatible changes that the milestone guides (written before v7 was current) do not anticipate:

1. **The `url` property in `datasource` is no longer supported in `schema.prisma`.** Migrations need it via a `prisma.config.ts` file, and the runtime client needs an explicit driver adapter (`@prisma/adapter-pg`, `@prisma/adapter-d1`, etc.) — `new PrismaClient()` with no arguments now throws *"PrismaClient needs to be constructed with a non-empty, valid PrismaClientOptions"*.

2. **The default generator output is now ESM-flavored TypeScript** (uses `import.meta.url`) and writes into a path you choose with `output = "..."`. The old `prisma-client-js` (which generated into `node_modules/@prisma/client`) is being phased out. The `prisma-client` generator's output is committed as source-controlled stubs OR generated at build time, but it lives **inside your source tree**.

Both changes affect:
- Where `DATABASE_URL` is loaded (build-time config vs runtime env)
- How NestJS service classes construct `PrismaClient` (must pass `adapter`)
- Webpack bundling (the generated client uses `import.meta.url`, which CommonJS targets reject)
- Jest unit tests (ts-jest CommonJS transform can't compile the generated ESM client)
- Docker image size (`@prisma/client@7`'s `optionalDependencies` include `prisma` CLI, `@prisma/studio-core`, `react`, `chart.js`, `effect`, etc., adding ~200 MB if not pruned)

These are the kind of cross-cutting decisions that, undocumented, look like ad-hoc workarounds in code review. This ADR records why each lever was pulled.

## Decision

**We adopt Prisma 7 with the following configuration:**

1. **`prisma.config.ts` at the workspace root** holds `datasource.url: env('DATABASE_URL')` for migrations. `schema.prisma` retains only `provider = "postgresql"` in its `datasource` block.

2. **Generator: `prisma-client`** (Prisma 7 default) with `output = "../src/generated/prisma"` — generated code lives in `apps/gateway/src/generated/prisma/` and is gitignored (`**/generated/prisma/`).

3. **`PrismaService` constructs with `@prisma/adapter-pg`**, reading `DATABASE_URL` from `@nestjs/config`'s `ConfigService.getOrThrow<string>('DATABASE_URL')`.

4. **`@nestjs/config` loads `.env.local` first, then `.env`** at app boot, so process.env has DATABASE_URL by the time PrismaService's constructor runs.

5. **`.npmrc` sets `auto-install-peers=false`** to keep the dependency graph explicit. Prisma 7 declares aggressive peer chains.

6. **Production Docker installs use `pnpm install --prod --no-optional`** to drop `prisma`, `typescript`, `@prisma/studio-core`, React, etc., which `@prisma/client@7.8.0` lists as `optionalDependencies`.

7. **Docker `prisma generate` step receives a placeholder `DATABASE_URL=postgresql://build:build@build/build`** because Prisma 7's config validates `env('DATABASE_URL')` even at codegen (no DB connection happens, but the env var must parse).

8. **Jest unit tests stub the generated client** via `moduleNameMapper`:
   `'^.*generated/prisma/client$': '<rootDir>/test/prisma-client.mock.ts'`
   to bypass the ESM `import.meta.url` that ts-jest CommonJS can't compile.

9. **`tsconfig.spec.json` includes `customConditions: null`** to clear the `customConditions: ["@org/source"]` from `tsconfig.base.json` (incompatible with `moduleResolution: "node10"`).

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Prisma 7 with adapter (chosen)** | Modern; matches Prisma's stated direction; driver adapters are the future | Six small accommodations across compose, Docker, jest, tsconfig | Future-proof; fits the senior practice goal |
| **Pin to Prisma 6.x** | Avoids all the v7 friction; legacy `url=env(...)` works as advertised | Stale within a year; future migration becomes a v6→v7 chore | Defers the work, doesn't eliminate it |
| **Use Prisma 7 with Prisma Accelerate** | No driver adapter needed; just pass `accelerateUrl` | Adds an external dependency (Prisma Cloud) just to dodge a config issue | Network latency cost not justified for a learning project; vendor lock-in |
| **Skip Prisma, use raw pg or Knex** | No 7-versus-6 issues at all | Lose typed query DSL, migration tooling, schema-as-code | The architectural value of Prisma's typed schema is real; we keep it |

## Consequences

**Positive:**

- Container image size dropped from 516 MB → 298 MB (under the milestone 1.0 target) once `--no-optional` was added to the production install.
- The driver adapter pattern is the same we'll use in milestone 1.1 for RLS GUC propagation — `PrismaPg` is a known shape we can wrap.
- `.env.local` is the single source of truth for both ConfigModule (in-process) and dotenv-cli wrappers (CLI commands).

**Negative / costs:**

- New engineers MUST read this ADR before touching Prisma config; the "obvious" `url = env("DATABASE_URL")` pattern from every blog post is wrong on v7.
- Six places carry coupled knowledge: `prisma.config.ts`, `schema.prisma`, `prisma.service.ts`, Dockerfile, `jest.config.cts`, `tsconfig.spec.json`. A change to any one without the others breaks builds in surprising ways.
- The generated client is a source-tree artifact — gitignored, but it physically lives in `apps/gateway/src/generated/prisma/`. Editor tooling treats it as part of the project, which is occasionally noisy.

**Risks:**

- `optionalDependencies` are a Prisma packaging choice that may change in a 7.x patch release. If it does, our `--no-optional` flag becomes either unnecessary or the wrong tool. Mitigation: track Prisma release notes.
- Migrating to a different driver adapter later (e.g., `@prisma/adapter-pglite` for tests, `@prisma/adapter-neon` for serverless) requires PrismaService changes. Acceptable; the seam is intentional.
- The placeholder `DATABASE_URL=postgresql://build:build@build/build` during codegen is a smell — it's a string that *looks* like a real URL. Mitigation: documented in the Dockerfile inline comment.

**Follow-up work this enables / forces:**

- Milestone 1.1 (RLS): `PrismaService` already has the adapter wired, so we'll wrap it with `$extends` for `SET LOCAL app.current_tenant_id` without restructuring.
- Phase 2: when introducing a second service with its own schema, replicate the prisma.config.ts pattern — likely a config-per-service.
- Phase 2/3: evaluate Prisma migration tooling (`prisma migrate deploy` in a Kubernetes init job) once we have multi-tenant migrations in flight.

## References

- Prisma 7 config docs: `prisma.io/docs/orm/reference/prisma-config-reference`
- Prisma no-Rust-engine page: `prisma.io/docs/orm/prisma-client/setup-and-configuration/no-rust-engine`
- Project root: `prisma.config.ts`, `apps/gateway/prisma/schema.prisma`, `apps/gateway/src/prisma/prisma.service.ts`
- `.npmrc` for `auto-install-peers=false`
- `apps/gateway/Dockerfile` for `--no-optional` and codegen placeholder
- Phase 1.0 milestone guide: [`../phase-1/00-foundations.md`](../phase-1/00-foundations.md), Step 3
