// Prisma 7 config for enrollment-service. See the same-named files for
// gateway / tenant-service / sis-service / academic-service.

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'apps/enrollment-service/prisma/schema.prisma',
  migrations: {
    path: 'apps/enrollment-service/prisma/migrations',
  },
  datasource: {
    url: env('ENROLLMENT_MIGRATION_URL'),
  },
});
