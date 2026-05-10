// Stub for the generated Prisma client used during jest unit tests.
// Same shape as sis-service's stub. Tests inject their own PrismaService
// double anyway, so this just needs to satisfy the type imports.
export class PrismaClient {
  constructor(_options?: unknown) {}
  $connect(): Promise<void> {
    return Promise.resolve();
  }
  $disconnect(): Promise<void> {
    return Promise.resolve();
  }
  $queryRaw<T = unknown>(): Promise<T[]> {
    return Promise.resolve([] as T[]);
  }
}
