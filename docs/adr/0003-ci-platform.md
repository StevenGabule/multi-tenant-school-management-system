# ADR-0003: GitHub Actions for CI

> **Status:** Accepted
> **Date:** 2026-05-10
> **Deciders:** self (project owner / sole engineer)

## Context

The project needs a CI pipeline that runs on every pull request and on `main` to:

- Catch type errors, broken tests, and build failures before code lands.
- Validate the Dockerfile builds.
- Eventually push container images to a registry (Phase 2).
- Eventually run integration / e2e tests against ephemeral databases.

Three industry-standard options dominate: **GitHub Actions**, **GitLab CI**, and self-hosted runners (Jenkins / Buildkite / CircleCI). The choice mostly hinges on where the source code lives — for monorepos hosted on GitHub, Actions has the lowest friction.

This is a learning project, but the patterns built here should transfer to any future production system.

## Decision

**We will use GitHub Actions** as the CI platform for Phase 1, with workflows committed in `.github/workflows/`.

The initial workflow `ci.yml` runs on `push` to `main` and on every `pull_request`. Steps:

1. Checkout (full history for `nx affected` base..head comparisons).
2. Setup pnpm via `pnpm/action-setup@v4`.
3. Setup Node 24 with pnpm cache via `actions/setup-node@v4`.
4. `pnpm install --frozen-lockfile`.
5. `prisma generate` (with a placeholder DATABASE_URL since codegen doesn't connect).
6. `nrwl/nx-set-shas@v4` to derive base/head SHAs on PRs.
7. `nx affected -t typecheck test build --exclude=@org/gateway-e2e` on PRs; `nx run-many -t typecheck test build` on main.
8. `docker build` to validate the gateway image.
9. Report image size as a workflow notice.

## Options considered

| Option | Pros | Cons | Rejected because |
|---|---|---|---|
| **GitHub Actions (chosen)** | First-class for GitHub-hosted repos; rich marketplace (pnpm setup, nx-set-shas, ghcr push); free for public repos; secrets management built-in; matrix builds; concurrency control | Vendor lock-in to GitHub; less flexible YAML than some alternatives; workflow re-run UX is clunky | n/a |
| **GitLab CI** | Excellent for GitLab-hosted repos; auto-DevOps; built-in container registry; merge train support | Wrong fit if the source repo is on GitHub (which is the default expectation here) | The repo is intended for GitHub |
| **Jenkins (self-hosted)** | Total control; no vendor lock-in; mature ecosystem | Operates a build cluster; out of scope for a learning project; security and patching burden | Operational overhead disproportionate to a one-engineer project |
| **CircleCI / Buildkite / Drone** | Strong CI-only tools; CircleCI's caching is excellent | Yet another vendor and yet another YAML dialect; no concrete advantage over Actions for this scope | No motivating benefit |

## Consequences

**Positive:**

- Every PR runs lint-equivalent (typecheck), tests, and build before merge — catches drift early.
- `nx affected` on PRs scales build/test cost with PR scope, not repo size — important once we have 5+ services.
- Docker build in CI validates the Dockerfile end-to-end, so container regressions surface in a PR rather than at deploy time.
- Workflow YAML is in-tree, version-controlled, code-reviewed.

**Negative / costs:**

- Vendor lock-in. Migrating to GitLab CI or Jenkins later is a multi-day rewrite.
- Self-hosted runners are an option but add operational cost; we use GitHub-hosted for now.
- Free tier minute caps will eventually bite at scale (currently 2,000 minutes/month for private repos on free tier).

**Risks:**

- Image registry push is deferred until we have a remote repo configured. Mitigation: documented in the workflow comments; revisit when the GitHub remote exists.
- ESLint not yet in the pipeline (deferred to milestone 1.3 per [ADR-0004](0004-prisma-7-setup.md) and the `@nx/eslint` generator instability). Mitigation: typecheck catches a meaningful subset of issues; lint added as separate step when 1.3 lands.
- Secrets for ghcr.io push will need careful scoping; that's a Phase 2 concern.

**Follow-up work this enables / forces:**

- Phase 2: ghcr.io push on main, signed images via cosign.
- Phase 2: ephemeral Postgres service container in CI for integration tests.
- Phase 2: matrix build across target architectures (amd64 + arm64) once we deploy beyond local kind.

## References

- GitHub Actions docs: `docs.github.com/actions`
- `nrwl/nx-set-shas`: `github.com/nrwl/nx-set-shas`
- Project root: `.github/workflows/ci.yml`
- Phase 1.0 milestone guide: [`../phase-1/00-foundations.md`](../phase-1/00-foundations.md), Step 8
