// Prisma 7+ central config. Connection URL lives here (not in schema.prisma).
// At runtime, env vars are loaded by:
//   - the npm scripts in package.json which wrap CLI calls with `dotenv -e .env.local`
//   - NestJS's ConfigModule (in-process) when the app starts
// We deliberately do NOT `import 'dotenv/config'` here — that would auto-load
// `.env`, but our convention is `.env.local`. Trust the wrapper.

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'apps/gateway/prisma/schema.prisma',
  migrations: {
    path: 'apps/gateway/prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
