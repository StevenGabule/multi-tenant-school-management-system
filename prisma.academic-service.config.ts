// Prisma 7 config for academic-service. See prisma.config.ts (gateway),
// prisma.tenant-service.config.ts, prisma.sis-service.config.ts for the
// same pattern.

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'apps/academic-service/prisma/schema.prisma',
  migrations: {
    path: 'apps/academic-service/prisma/migrations',
  },
  datasource: {
    url: env('ACADEMIC_MIGRATION_URL'),
  },
});
