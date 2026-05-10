// Prisma 7 config for sis-service. See prisma.config.ts (gateway) +
// prisma.tenant-service.config.ts for the same pattern. Multiple schemas
// = multiple configs (Prisma's defineConfig has a single schema field).

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'apps/sis-service/prisma/schema.prisma',
  migrations: {
    path: 'apps/sis-service/prisma/migrations',
  },
  datasource: {
    url: env('SIS_MIGRATION_URL'),
  },
});
