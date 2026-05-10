# Multi-Tenant School Management System

A learning project for senior-level software engineering practice. The architecture is documented in [`documentation.md`](documentation.md); the build is staged across [Phase 1 milestones](docs/INDEX.md). Decisions live in [`docs/adr/`](docs/adr/).

> **Status:** Phase 1, Milestone 1.0 (Foundations & walking skeleton).
> Single service (`gateway`), Postgres + Jaeger via Docker Compose, deployable to local kind. Real domain begins in milestone 1.3.

---

## Quick start (target: clone-to-running in under 30 minutes)

### Prerequisites

- Node.js 20+ (we run 24)
- pnpm 10+
- Docker (Compose v2)
- `kubectl` and `kind` if you want to exercise step 7

### 1. Install

```bash
pnpm install
cp .env.example .env.local      # then edit credentials if you want
```

### 2. Bring up local infra

```bash
docker compose -f infra/docker-compose.yml up -d
# postgres on host 5433, jaeger UI on http://localhost:16686, adminer on http://localhost:8081
```

### 3. Apply the first migration

```bash
pnpm prisma:gateway:migrate:init
```

### 4. Run the gateway

```bash
pnpm exec nx serve @org/gateway
# in another terminal:
curl http://localhost:3000/livez
curl http://localhost:3000/readyz
curl http://localhost:3000/api
# open http://localhost:16686 — see traces under service "gateway"
```

### 5. (Optional) Deploy to kind

See [`infra/k8s/gateway/README.md`](infra/k8s/gateway/README.md) for the full flow. Short version:

```bash
kind create cluster --name sms-dev
docker network connect sms_default sms-dev-control-plane
docker build -t sms-gateway:dev -f apps/gateway/Dockerfile .
kind load docker-image sms-gateway:dev --name sms-dev

# Create the secret from .env.local
kubectl --context kind-sms-dev create secret generic gateway-secret \
  --from-literal=DATABASE_URL="$(grep ^DATABASE_URL .env.local | cut -d= -f2-)" \
  --dry-run=client -o yaml | kubectl --context kind-sms-dev apply -f -

kubectl --context kind-sms-dev apply -f infra/k8s/gateway/
kubectl --context kind-sms-dev port-forward svc/gateway 3010:3000
# in another terminal:
curl http://localhost:3010/readyz
```

---

## Layout

```
.
├── apps/
│   └── gateway/                 ← NestJS service (Phase 1 walking skeleton)
│       ├── prisma/              ← schema.prisma + migrations
│       ├── src/                 ← main.ts loads OTel first, then NestFactory
│       │   ├── app/             ← AppModule, AppController (placeholder)
│       │   ├── health/          ← /livez, /readyz
│       │   ├── prisma/          ← PrismaService extending PrismaClient
│       │   └── instrumentation.ts  ← OTel SDK init
│       ├── Dockerfile           ← multi-stage, ~298MB
│       └── jest.config.cts
├── libs/                        ← (empty until milestone 1.2)
├── infra/
│   ├── docker-compose.yml       ← postgres, jaeger, adminer
│   └── k8s/gateway/             ← Deployment, Service, ConfigMap (Secret gitignored)
├── docs/
│   ├── INDEX.md                 ← Phase 1 roadmap
│   ├── adr/                     ← Architecture Decision Records
│   └── phase-1/                 ← per-milestone guides
├── prisma.config.ts             ← Prisma 7 datasource URL lives here
├── CONTEXT.md                   ← domain glossary
└── documentation.md             ← original architecture document
```

## Common commands

| Command | What it does |
|---|---|
| `pnpm exec nx serve @org/gateway` | Run the gateway locally with hot-reload |
| `pnpm exec nx build @org/gateway` | Build the bundled `dist/main.js` |
| `pnpm exec nx test @org/gateway` | Run unit tests |
| `pnpm prisma:gateway:migrate` | Run a new migration (interactive name prompt) |
| `pnpm prisma:gateway:generate` | Regenerate the Prisma client |
| `pnpm prisma:gateway:studio` | Open Prisma Studio in the browser |
| `docker compose -f infra/docker-compose.yml up -d` | Start postgres + jaeger + adminer |
| `docker compose -f infra/docker-compose.yml down` | Stop them (add `-v` to wipe data) |
| `docker build -t sms-gateway:dev -f apps/gateway/Dockerfile .` | Build the runtime image |

## What's intentionally simple in milestone 1.0

- **Single service.** Real domain models start in milestone 1.3.
- **Postgres on the host (compose), not in kind.** Avoids networking complexity early. Phase 2 moves data plane into the cluster.
- **No tenant context yet.** RLS, GUCs, and the cross-tenant test arrive in milestone 1.1.
- **No frontend.** Backend-only per the project's Phase 1 scope.
- **No Nx Cloud, no service mesh, no Kafka.** Each gets a milestone or an ADR justification.

## Where to look next

- [`docs/INDEX.md`](docs/INDEX.md) — the Phase 1 roadmap (10 milestones).
- [`docs/phase-1/00-foundations.md`](docs/phase-1/00-foundations.md) — what milestone 1.0 was supposed to teach.
- [`docs/adr/`](docs/adr/) — every load-bearing decision and why.
- [`CONTEXT.md`](CONTEXT.md) — domain glossary; grow it as you learn.
