# ADR-0002: Use Nx as the monorepo build tool

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

The architecture document calls for ~15–20 services by the end of Phase 3 (gateway, BFFs, SIS, academic, fees, etc.) plus shared libraries (auth, prisma, dto, observability). The repository will need:

- A consistent way to add new services without rewriting tooling each time.
- Per-PR build/test scoping so a one-line change in `bff-parent` doesn't rebuild every service.
- A shared TypeScript and dependency graph so cross-service refactors are tractable.
- Generators that scaffold new services with the same conventions every time.
- A path to remote caching when the build matrix grows.

Three TypeScript monorepo tools dominate the space: **Nx** (Nrwl), **Turborepo** (Vercel), and **Lerna** (now under Nrwl). Each could plausibly host this project; the choice is hard to reverse cheaply once dozens of files reference workspace conventions.

The MILESTONE's stated goal is to teach senior-level practice; a real-team posture matters more than minimum viable scaffolding.

## Decision

**We will use Nx as the monorepo build tool**, with `pnpm` as the package manager and `pnpm-workspace.yaml` declaring `apps/*` and `libs/*` as workspace roots.

Nx is initialized with `--preset=apps` (an empty workspace) and the `@nx/js/typescript`, `@nx/webpack`, and `@nx/nest` plugins added on demand.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **Nx (chosen)** | First-class generators per framework (`@nx/nest`, `@nx/eslint`, `@nx/jest`); affected-graph; remote cache (Nx Cloud or self-hosted); large enterprise install base; opinionated about layout which keeps services consistent | Heavier than Turborepo; v22 has occasional generator-path inconsistencies (we hit one for ESLint); plugin sprawl in `.github`/`.claude`/`.cursor` etc. | n/a |
| **Turborepo** | Lightweight, fast remote cache, Vercel-native, good for Next.js heavy stacks | Fewer first-class scaffolding generators; we'd hand-roll service templates each time; less common in NestJS shops | We need the NestJS generator velocity more than we need Turborepo's leanness |
| **Lerna (modern)** | Same Nrwl team as Nx; simpler; pure publish-oriented | Designed for publishable npm packages, not multi-app product monorepos; affected-graph weaker than Nx | Wrong shape for a deployable multi-service product |
| **No monorepo tool (pnpm workspaces only)** | Minimum dependencies | Have to build affected-graph, generators, caching ourselves | Reinventing what Nx gives us free |

## Consequences

**Positive:**

- New services are generated with `nx g @nx/nest:app <name>` — conventions enforced.
- `nx affected -t typecheck test build` on PRs scales with the monorepo's growth without hand-rolled CI logic.
- TypeScript path mappings, project references, and dependency graphs are managed by Nx — we won't drift.
- The `prune-lockfile` and `copy-workspace-modules` Nx targets give us a path to slim Docker images later when libs/ start being consumed.

**Negative / costs:**

- Nx scaffold ships AI-tooling configs (.agents/, .claude/, .codex/, .cursor/, .gemini/, .opencode/, AGENTS.md, CLAUDE.md, opencode.json) regardless of which AI tool the user actually uses. Repo bloat. Acceptable for now; prune later.
- The webpack plugin adds a `webpack.config.js` per app. For Node services, we're tied to Nx's webpack flavor; switching to esbuild/swc later means rewriting build targets.
- Nx Cloud is an upsell — we explicitly opted out (`--nxCloud=skip`). Remote cache becomes a self-hosted concern when CI gets slow.

**Risks:**

- Nx's flat-config ESLint generator path is brittle in v22 (we hit `Unable to resolve @nx/eslint:configuration`). Mitigation: ESLint deferred to milestone 1.3; revisit once version churn settles.
- Nx Cloud pricing if we accidentally enable it via a misclick. Mitigation: explicit `analytics: false` in nx.json and no Cloud token in CI secrets.
- Generator changes between major Nx versions. Mitigation: treat Nx upgrades as ADR-worthy events; pin to a specific version in CI (`pnpm exec nx ...` reads from lockfile).

**Follow-up work this enables / forces:**

- Each new service in milestones 1.2+ goes through `nx g @nx/nest:app`.
- `nx affected` becomes the CI workhorse from milestone 1.0 onwards.
- A future ADR may swap webpack for esbuild via `@nx/esbuild` if cold-start becomes an issue.

## References

- Nx documentation: `nx.dev/getting-started`
- Project root: `nx.json`, `pnpm-workspace.yaml`
- Phase 1.0 milestone guide: [`../phase-1/00-foundations.md`](../phase-1/00-foundations.md), Step 1
