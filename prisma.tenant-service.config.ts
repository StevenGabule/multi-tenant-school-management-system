// Prisma 7 config for tenant-service (control plane).
// See prisma.config.ts for the gateway equivalent.
//
// Why two configs and not one: Prisma's defineConfig has a single `schema`
// field. Multiple services means multiple schemas means multiple configs.
// We pass --config explicitly via the npm scripts in package.json.

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'apps/tenant-service/prisma/schema.prisma',
  migrations: {
    path: 'apps/tenant-service/prisma/migrations',
  },
  datasource: {
    url: env('CONTROL_PLANE_MIGRATION_URL'),
  },
});
