import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import {
  TENANT_REGISTRY_OPTIONS,
  TenantRegistryOptions,
  TenantRegistryService,
} from './tenant-registry.service';

export interface TenantRegistryAsyncOptions {
  imports?: Array<Type<unknown> | DynamicModule>;
  inject?: unknown[];
  useFactory: (
    ...args: unknown[]
  ) => Promise<TenantRegistryOptions> | TenantRegistryOptions;
}

@Module({})
export class TenantRegistryModule {
  /**
   * Async config (typical: factory pulls values out of @nestjs/config).
   *
   *   TenantRegistryModule.forRootAsync({
   *     imports: [ConfigModule],
   *     inject: [ConfigService],
   *     useFactory: (config: ConfigService) => ({
   *       baseUrl: config.getOrThrow('TENANT_SERVICE_BASE_URL'),
   *       redisUrl: config.getOrThrow('REDIS_URL'),
   *       invalidationChannel: config.get('REDIS_INVALIDATION_CHANNEL'),
   *     }),
   *   })
   */
  static forRootAsync(opts: TenantRegistryAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: TENANT_REGISTRY_OPTIONS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useFactory: opts.useFactory as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inject: opts.inject as any[] | undefined,
    };

    return {
      module: TenantRegistryModule,
      global: true,
      imports: opts.imports ?? [],
      providers: [optionsProvider, TenantRegistryService],
      exports: [TenantRegistryService],
    };
  }

  /** Eager (rare; mostly for tests with hardcoded options). */
  static forRoot(options: TenantRegistryOptions): DynamicModule {
    return {
      module: TenantRegistryModule,
      global: true,
      providers: [
        { provide: TENANT_REGISTRY_OPTIONS, useValue: options },
        TenantRegistryService,
      ],
      exports: [TenantRegistryService],
    };
  }
}
