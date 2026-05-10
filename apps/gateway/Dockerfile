# syntax=docker/dockerfile:1.7

# Multi-stage Dockerfile for the gateway service.
#
# Stages:
#   deps       — install ALL workspace deps once (cached on lockfile)
#   build      — generate Prisma client + nx build → apps/gateway/dist/main.js
#   prod-deps  — fresh `pnpm install --prod` for the runtime image
#   runtime    — minimal node:24-alpine; copies main.js + prod node_modules +
#                prisma schema/migrations. Runs as the unprivileged `node` user.
#
# The webpack target=node configuration externalizes node_modules, so the
# bundled main.js does `require('@nestjs/core')` etc. at runtime. That's why
# the runtime stage needs node_modules on disk (not vendored into main.js).

# ──────────────── Stage 1: deps ────────────────
FROM node:24-alpine AS deps
WORKDIR /app

# Pin pnpm via corepack to keep CI and local dev in lockstep
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

# Manifests only → maximizes cache reuse across source edits
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/gateway/package.json apps/gateway/

RUN pnpm install --frozen-lockfile

# ──────────────── Stage 2: build ────────────────
FROM deps AS build

# Source last so previous layers (deps install) stay cached
COPY tsconfig.base.json tsconfig.json prisma.config.ts nx.json ./
COPY apps ./apps
COPY libs ./libs

# Generate the Prisma client into apps/gateway/src/generated/prisma/.
# Prisma 7's config validates DATABASE_URL even for codegen, so we pass a
# placeholder; no DB connection happens during `generate`.
RUN DATABASE_URL=postgresql://build:build@build/build \
    pnpm exec prisma generate --schema apps/gateway/prisma/schema.prisma

# Webpack bundle: produces apps/gateway/dist/main.js (with externals)
RUN pnpm exec nx build @org/gateway

# ──────────────── Stage 3: prod-deps ────────────────
# Same lockfile, --prod flag → trims dev dependencies for a slim runtime tree
FROM node:24-alpine AS prod-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/gateway/package.json apps/gateway/

RUN pnpm install --frozen-lockfile --prod --no-optional

# ──────────────── Stage 4: runtime ────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    OTEL_SERVICE_NAME=gateway

# Bundled output
COPY --from=build /app/apps/gateway/dist/main.js ./apps/gateway/dist/main.js
# Prisma schema + migrations live in the image so `prisma migrate deploy`
# can be invoked from a Kubernetes init job or a one-shot CI step.
COPY --from=build /app/apps/gateway/prisma ./apps/gateway/prisma

# Production-only deps (with the workspace shape pnpm expects)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/gateway/node_modules ./apps/gateway/node_modules

# Workspace manifests so pnpm-resolved symlinks line up
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/

# Drop privileges
USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/livez', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["node", "apps/gateway/dist/main.js"]
