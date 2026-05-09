# Phase 1.0 — Foundations & walking skeleton

> **Concepts:** Nx monorepo, NestJS application bootstrap, Prisma + PostgreSQL local dev, OpenTelemetry from line one, multi-stage Dockerfile, local Kubernetes (kind), minimal CI pipeline, first ADR
> **Estimated effort:** 2–3 weekends of focused work (do not rush — this layer is load-bearing for everything that follows)
> **Status:** Not Started
> **Prerequisites:**
> - Node.js 20+ and pnpm installed
> - Docker Desktop or Colima (with Compose v2)
> - `kubectl` and `kind` installed (or `minikube` if you prefer)
> - Basic git proficiency (branching, conventional commits, squash-merge)
> - Read [`../../documentation.md`](../../documentation.md) §3, §7, §8 once

---

## What you'll learn

- Why monorepos win over polyrepos for vertical SaaS, and what the *real* tradeoffs look like (build graph complexity, ownership friction, CI matrix size).
- How a NestJS application bootstraps from `main.ts` and what each layer (`AppModule`, providers, controllers, lifecycle hooks) is responsible for.
- The Prisma development loop: `schema.prisma` → `prisma migrate dev` → generated client → application use, including the difference between `migrate` and `db push`.
- Why OpenTelemetry must be bootstrapped *before* any other module (the auto-instrumentation contract) and what "context propagation" actually means at the SDK level.
- Multi-stage Dockerfile patterns and why a 2 GB image is a smell, not just an annoyance.
- The Kubernetes object graph for a stateless service — `Deployment`, `Service`, `ConfigMap`, `Secret`, `Probe` — and how each one fails.
- The difference between a liveness probe, a readiness probe, and a startup probe — and why getting them wrong is one of the most common production outages.
- The discipline of writing your first ADR while the decision is fresh, not retroactively.

---

## Why this matters (senior perspective)

Every team that skips foundations pays for it three months later. The forms it takes:

- **OTel added later never gets added.** You spend three sprints writing features, then a production incident hits and you have no traces. By the time someone wires up tracing, the call graph has 12 services and the auto-instrumentation now has to be retrofitted into hand-rolled middleware that doesn't honor context propagation. Bootstrap OTel before the first feature, even if there's nothing to trace yet.
- **Local dev that "works on my machine" rots the team.** If a new contributor can't get a green build in 30 minutes, they will write code that breaks on someone else's machine, and the team will spend 20% of its time on environment problems forever.
- **A Dockerfile written carelessly produces a 2 GB image.** That image takes 90 seconds to push, 30 seconds to pull on each pod start, and triples your registry costs. Fixing a Dockerfile *after* you have 12 of them means rewriting 12 things instead of one.
- **Kubernetes objects that "just work" hide failure modes.** The first time you deploy a service without a readiness probe and traffic hits a pod that's still loading config, you'll learn why this milestone treats probes as required, not optional.
- **Walking skeletons are a senior pattern.** The phrase comes from Alistair Cockburn: build the thinnest end-to-end thread through every layer of the system *first*, then fatten each layer. The temptation is the opposite — build the domain model "properly" first, then "wire it up later." Teams that do this discover at integration time that their domain model can't be wired up at all. You will resist this temptation by completing this milestone before adding a single feature.

The walking skeleton you build here is not a prototype. **You will keep this code.** Treat every line as production-bound.

---

## Hands-on plan

The plan below names the *what* and the *why*. It deliberately does not give you complete code — you write it. The senior skill is reading docs, choosing patterns, and defending the choice.

### Step 1 — Bootstrap the Nx monorepo

1. Initialize an Nx workspace in this repository: `pnpm create nx-workspace@latest --preset=ts --packageManager=pnpm` (run in a tmp dir, then move files in — the existing `documentation.md` and `docs/` must be preserved).
2. Generate your first NestJS application: `nx g @nx/nest:app gateway` (we'll repurpose this as the API gateway / first service).
3. Verify `nx serve gateway` runs and `curl localhost:3000` returns 404 (NestJS default).

**Why Nx:**
- Build graph awareness (`nx affected`) means PRs only build/test what changed — critical when you have 10+ services later.
- First-class generators (`nx g @nx/nest:app`, `nx g @nx/nest:lib`) keep boilerplate consistent across services.
- Remote caching (Nx Cloud or self-hosted) makes CI 5–10× faster on repeated builds.

**ADR moment:** Why Nx over Turborepo or Lerna? Write [`adr/0002-monorepo-tooling.md`](../adr/) when you commit to one. Defending a choice you didn't have to defend is the practice that makes ADR-writing a habit.

### Step 2 — Local PostgreSQL via Docker Compose

1. Create `infra/docker-compose.yml` at the repo root with one `postgres:16-alpine` service exposing port 5432 (mapped to host) and a named volume for data persistence.
2. Set strong-but-throwaway credentials via environment variables loaded from a `.env.local` file (gitignored). **Never** commit credentials, even for local dev — this is the habit, not the security need.
3. Add a `pgadmin` or `adminer` service for visualization. Optional but useful when debugging RLS in milestone 1.1.

**Why Docker Compose:**
- Reproducible: every contributor gets the same Postgres version, locale, encoding, extensions.
- Disposable: `docker compose down -v` resets state without affecting your host.
- Production resemblance: the image is the same family you'll run via your managed Postgres in cloud (RDS Postgres, Cloud SQL, etc.).

**Pitfall to avoid:** Do not install Postgres natively on your dev machine "just for speed." The drift between your local 14.x and the deployed 16.x will eventually waste a day.

### Step 3 — Prisma setup

1. `pnpm add prisma @prisma/client` at workspace root, `pnpm prisma init` inside `apps/gateway/`.
2. Define a placeholder model — e.g., a `HealthCheck` table with `id`, `checkedAt` columns. We do not build the real domain here. This is purely to exercise the migration loop.
3. Run `pnpm prisma migrate dev --name init`. Verify the migration file lands in `prisma/migrations/` and the database has the table.
4. Generate the client and integrate `PrismaClient` as a NestJS provider via a `PrismaService` (extend `PrismaClient`, implement `OnModuleInit` to call `$connect()`, `OnModuleDestroy` to call `$disconnect()`).

**Why Prisma:**
- Schema-first model that forces a single source of truth.
- Excellent TypeScript ergonomics — the generated types catch ~30% of bugs at compile time.
- Documented multi-tenant patterns (we'll lean on `$extends` heavily in milestone 1.1).

**Pitfall to avoid:** Beginners reach for `prisma db push` because it's faster. **Never** use `db push` outside the very first iteration. It bypasses migrations, which means your schema history has gaps, which means you cannot reliably reproduce or roll back. Use `migrate dev` from line one.

**Schema vs migrations confusion:** `schema.prisma` is the desired state; migrations are the journal of how you got there. Production runs migrations; `schema.prisma` is the source for type generation. Get this distinction lodged before milestone 1.1.

### Step 4 — A real `/healthz` endpoint

Create a `HealthController` with two endpoints:

- `GET /livez` — returns 200 if the process is alive. Does **not** touch the database. Used by Kubernetes liveness probes.
- `GET /readyz` — returns 200 only if the application can serve traffic, including a successful `SELECT 1` against Postgres. Used by Kubernetes readiness probes.

**Why two endpoints, not one:**
- Liveness failure → Kubernetes restarts the pod. If `/livez` checks the DB, a transient Postgres blip restarts every pod simultaneously, taking the service down.
- Readiness failure → Kubernetes stops sending traffic but does *not* restart. This is what you want when the DB is unhealthy.

The "single `/healthz`" anti-pattern is everywhere on the internet. Resist it. Read the Kubernetes docs on probes carefully — this is foundational knowledge for every milestone after this one.

### Step 5 — OpenTelemetry from line one

This is the most-skipped, highest-value step. Do **not** defer it.

1. `pnpm add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http`.
2. Create `apps/gateway/src/instrumentation.ts` that initializes the SDK with `getNodeAutoInstrumentations()` and configures an OTLP HTTP exporter pointing at `http://localhost:4318/v1/traces`.
3. Bootstrap *before* `AppModule` is imported. The pattern is `import './instrumentation'` as the **very first line** of `main.ts`. Auto-instrumentation patches the `http`, `pg`, `@nestjs/core`, etc. modules at require time — if your app code loads before instrumentation, those modules are already loaded and patching is a no-op.
4. Add a Jaeger or Tempo container to `docker-compose.yml`. Jaeger all-in-one is the easiest start (`jaegertracing/all-in-one:latest`).
5. Hit `/readyz` and verify a trace appears in Jaeger UI (default `localhost:16686`).

**Why this matters here:** every later milestone assumes traces are available. You cannot debug a saga (milestone 1.5) without distributed tracing. You cannot prove a cross-tenant test passed (milestone 1.1) without spans showing the GUC was set. OTel is not an observability feature — it is the *substrate* observability is built on.

**Pitfall to avoid:** Reading a tutorial that wraps OTel initialization inside `AppModule.forRoot()` or a NestJS provider. By the time NestJS providers initialize, your application code has already imported `http` and `pg`, and instrumentation is too late. The init must happen at the top of `main.ts`, before any other import.

### Step 6 — Multi-stage Dockerfile

Write a Dockerfile at `apps/gateway/Dockerfile` with these stages:

1. **`deps`** — `node:20-alpine`, copy `package.json`/`pnpm-lock.yaml`, run `pnpm install --frozen-lockfile --prod=false`. This stage is cached as long as dependencies don't change.
2. **`build`** — copy source, run `nx build gateway --prod`. This produces `dist/apps/gateway/`.
3. **`runtime`** — `node:20-alpine`, copy only `dist/`, `node_modules/` (production-only), `prisma/schema.prisma` and `prisma/migrations/`. Set `USER node`. Set `ENTRYPOINT ["node", "dist/apps/gateway/main.js"]`.

**Why multi-stage:**
- Single-stage builds carry build-time toolchain (TypeScript compiler, dev dependencies, `.git`, source files) into the runtime image. 1.5–2 GB is typical.
- Multi-stage with a `node:20-alpine` runtime stage produces ~150–250 MB images. 5–10× smaller. Faster pulls, faster cold starts, lower registry bills.

**Pitfall to avoid:** copying `node_modules/` from the build stage into runtime. You want a *fresh* `pnpm install --prod` in the runtime stage (or use `pnpm deploy` to extract the prod tree). Otherwise dev dependencies hitchhike.

**Image scanning** is a senior habit. Run `trivy image <your-image>` and read the output. Even a `node:20-alpine` base has CVEs — knowing which ones, why they apply (or don't), and how to suppress with justification is the difference between a check-the-box engineer and a security-conscious one.

### Step 7 — Local Kubernetes via kind

1. `kind create cluster --name sms-dev`.
2. Build your image and load it into kind: `docker build -t sms-gateway:dev -f apps/gateway/Dockerfile .` then `kind load docker-image sms-gateway:dev --name sms-dev`.
3. Write Kubernetes manifests in `infra/k8s/gateway/` (start with plain YAML; Helm comes in Phase 2):
   - `Deployment` with 1 replica, `image: sms-gateway:dev`, `imagePullPolicy: IfNotPresent`, the env vars your app needs, and **both probes configured**.
   - `Service` of type `ClusterIP` exposing port 3000.
   - `ConfigMap` for non-sensitive config; `Secret` (created via `kubectl create secret`, not committed) for credentials.
4. `kubectl apply -f infra/k8s/gateway/` and verify `kubectl get pods` shows `Running 1/1 Ready`.
5. Port-forward and hit the service: `kubectl port-forward svc/gateway 3000:3000`, then `curl localhost:3000/readyz`.

**Postgres on kind:** the simplest path is to keep Postgres in `docker compose` running on your host and have the kind pod connect to `host.docker.internal` (Docker Desktop) or the host's Docker bridge IP (Linux). Running Postgres inside kind itself is unnecessary at this stage; it adds complexity that doesn't teach anything new.

**Pitfall to avoid:** Specifying probes with the default `initialDelaySeconds: 0`. Your application takes 2–10 seconds to bootstrap. With zero delay, the first probe fails, the pod is killed, and you get a `CrashLoopBackOff` that looks like "my code is broken" but is actually a probe configuration bug. Set `initialDelaySeconds: 10` and `failureThreshold: 3` until you measure your actual cold-start time.

### Step 8 — Minimal CI pipeline

Create `.github/workflows/ci.yml` (or the GitLab CI / Jenkins / Bitbucket equivalent — pick one and write an ADR).

Triggers: pull request opened, push to main.

Stages:

1. **Lint** — `nx run-many --target=lint --all`.
2. **Typecheck** — `nx run-many --target=typecheck --all` (NestJS + Prisma generates types you must check).
3. **Test** — `nx run-many --target=test --all` (unit tests only at this stage; integration tests get a Postgres service container in milestone 1.1).
4. **Build** — `nx run-many --target=build --all` to ensure all artifacts compile.
5. **Container build** — build the Dockerfile and push to a registry (GitHub Container Registry is free for public repos; for private, set up an account or run a local registry in CI).

**Use `nx affected` mode for PR runs**, not `--all`. The first time you change a comment in one service and CI rebuilds and tests every service, you'll feel why this matters.

**Pitfall to avoid:** Skipping the container build in CI because it's "slow." Container build failures in production are the most embarrassing kind — they happen at deploy time, not at code-review time. CI catching them is non-negotiable.

### Step 9 — Document everything in CONTEXT.md and write the first ADR

1. Update [`../CONTEXT.md`](../../CONTEXT.md) with the domain glossary as you understand it so far. Even a half-empty CONTEXT.md is useful — it's a forcing function for naming things consistently.
2. Write [`adr/0002-monorepo-tooling.md`](../adr/) defending your Nx vs Turborepo choice (or write `0003-ci-platform.md` for your CI platform choice — whichever you find harder to defend).

The ADR practice only sticks if you do it now, while the decision is fresh and the alternatives are still in your head. Two weeks later, you will not remember why you picked one over the other, and the ADR will read as a rationalization rather than a decision.

---

## Definition of done

You may not move to milestone 1.1 until **all** of these are checked:

- [ ] `pnpm install` from a fresh clone produces no errors.
- [ ] `docker compose up` brings up Postgres and Jaeger; both are reachable.
- [ ] `nx serve gateway` runs the service locally; `curl localhost:3000/livez` returns 200, `curl localhost:3000/readyz` returns 200.
- [ ] `prisma migrate dev` applied at least one migration; the migration is in version control.
- [ ] Hitting `/readyz` produces a trace visible in the Jaeger UI showing the HTTP span and the Prisma query span (auto-instrumentation works).
- [ ] `docker build` succeeds; the resulting image is **under 300 MB**.
- [ ] `trivy image` has been run at least once; output reviewed (not necessarily clean).
- [ ] kind cluster running; `kubectl apply` deploys the gateway; `kubectl get pods` shows `Running 1/1 Ready`.
- [ ] Both liveness and readiness probes are configured with non-default `initialDelaySeconds` based on a *measured* cold-start time, not guessed.
- [ ] Port-forward to the kind service produces 200 on `/readyz` end-to-end.
- [ ] CI pipeline green on a PR. Lint, typecheck, test, build, container build all pass.
- [ ] At least one ADR written for a non-default choice (target: 2 ADRs by end of milestone 1.0).
- [ ] You can stand up the entire stack from a fresh clone in under 30 minutes, by following only your own README. (If a future-you can't, neither can anyone else.)

---

## Common pitfalls

1. **OTel initialization in `AppModule.forRoot()` instead of top of `main.ts`.** Auto-instrumentation depends on patching modules at require time. By the time NestJS bootstraps, `http` and `pg` are already loaded. Symptom: spans appear for some requests but not others, or HTTP spans appear but not DB spans.
2. **Prisma client generated inside the build stage but not copied to runtime stage.** Symptom: `Cannot find module '.prisma/client'` at runtime.
3. **Single `/healthz` endpoint that checks the DB.** A Postgres blip cascades into a pod restart storm. Symptom: every pod simultaneously enters `CrashLoopBackOff` during a brief DB hiccup.
4. **Using `host.docker.internal` on Linux without `--add-host=host.docker.internal:host-gateway`.** The hostname doesn't resolve on Linux Docker by default.
5. **Probes with `initialDelaySeconds: 0` or `1`.** Pods crash on first deploy; symptom looks like a code bug but is a config bug.
6. **`prisma db push` for "speed" during development.** Schema drifts; you cannot reproduce a teammate's setup; production migrations break.
7. **Committing `.env` files with credentials.** Even a "throwaway" credential committed once stays in git history forever and trains the wrong reflex.
8. **Skipping the ADR because "it's just my project."** This habit only forms under pressure. Form it now.
9. **CI without `nx affected`.** A 5-second comment change rebuilds 10 services. Demoralizing.
10. **A 30-minute "from fresh clone to running" experience that you've never actually tested.** Test it. Wipe `node_modules` and `.docker`, follow your own README. The friction you find is what every contributor would have hit.

---

## Stretch goals (optional rabbit holes)

These are for when you want to go deeper into a single subtopic rather than racing to milestone 1.1. Each could absorb a weekend by itself.

- **Generate a second service (`nx g @nx/nest:app academic`) that does nothing.** Verify `nx affected` correctly only builds/tests the changed app.
- **Replace plain Kubernetes YAML with a Helm chart.** Notice how much complexity the templating introduces. ADR-worthy: when does Helm become worth its tax?
- **Add `lefthook` or `husky` pre-commit hooks** for lint, typecheck, and conventional-commit message validation. Senior teams prevent broken commits at write time, not at CI time.
- **Set up a local container registry** (e.g., `registry:2` in compose) and have CI push there. Now your kind cluster pulls from a registry instead of `kind load`. More like production.
- **Implement OTel manual instrumentation** for one critical span (e.g., the `/readyz` DB check). Auto-instrumentation gives you everything for free; manual instrumentation forces you to understand spans, attributes, status codes, and propagation. This is the knowledge you'll wish you had during milestone 1.5.
- **Add structured JSON logging** with `pino` or NestJS's built-in logger configured for JSON. Set up correlation between logs and traces using OTel's `traceId`/`spanId` injection.
- **Read the Kubernetes probes documentation in full** and write a paragraph in your ADR archive about the difference between liveness, readiness, and startup probes. Non-default choices invite ADRs.

---

## Reflection questions

Answer these honestly in your own words *before* moving to milestone 1.1. Write the answers in a private notes file or as a section in your ADR — articulating tradeoffs is the senior skill.

1. **Why bootstrap OTel before the first feature?** What does the codebase look like in three months if you defer it?
2. **What is the difference between `/livez` and `/readyz`?** Describe one production scenario where conflating them causes an outage.
3. **What does `nx affected` save you, in concrete numbers, on a 10-service monorepo with a typical PR touching 1 service?**
4. **Why is `prisma db push` dangerous past day one?** Walk through what happens when a teammate clones your repo a week later.
5. **If you had to onboard a new contributor in 30 minutes, what is the documented path?** Did your README actually achieve that, or did you hand-hold yourself through gaps?
6. **What surprised you most during this milestone?** (Genuinely — if nothing surprised you, you may have skimmed the docs rather than learning.)
7. **What is one decision you made that a different reasonable engineer would have made differently?** Did you write an ADR for it?

---

## References (curated, not exhaustive)

- **Nx documentation** — `nx.dev/getting-started`. Read the "Mental Model" section before reaching for generators.
- **NestJS documentation** — `docs.nestjs.com/first-steps` and the chapter on "Lifecycle events" (`OnModuleInit`, `OnApplicationShutdown` matter for Prisma cleanup).
- **Prisma documentation** — `prisma.io/docs/getting-started`, especially `Schema overview` and `Migrate concepts`. Skim `prisma.io/docs/orm/prisma-client/queries/transactions` now; you'll re-read it in milestone 1.1.
- **OpenTelemetry JS** — `opentelemetry.io/docs/instrumentation/js/getting-started/nodejs/`. Pay attention to *where* the SDK init runs in the example.
- **Kubernetes probes** — `kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/`. Read in full at least once.
- **Multi-stage Dockerfile patterns** — `docs.docker.com/build/building/multi-stage/`.
- **kind quickstart** — `kind.sigs.k8s.io/docs/user/quick-start/`.
- **Alistair Cockburn — *Walking Skeleton*** — search for the term; the original 2004 article in *Crystal Clear* is the canonical source.
- **Project documentation:** [`../../documentation.md`](../../documentation.md) §3 (Microservices Architecture) and §7 (DevOps & Observability).

---

## When you're done

Update [`../INDEX.md`](../INDEX.md) — change milestone 1.0 status from `Not Started` to `Done`. Open milestone 1.1 (Tenant context done right). The walking skeleton you just built is about to grow its first real safety net.
