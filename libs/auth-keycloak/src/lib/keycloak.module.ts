import {
  DynamicModule,
  InjectionToken,
  Module,
  OptionalFactoryDependency,
} from '@nestjs/common';
import { KeycloakAuthGuard } from './keycloak-auth.guard.js';
import { KeycloakService } from './keycloak.service.js';
import { KEYCLOAK_OPTIONS } from './tokens.js';

export interface KeycloakOptions {
  /** OIDC issuer URL — e.g. http://localhost:8080/realms/sms-platform */
  issuerUrl: string;
  /** Required JWT `aud` value — typically 'gateway'. */
  audience: string;
  /** JWKS cache cooldown in ms. Default 10 minutes. */
  jwksCacheMs?: number;
}

export interface KeycloakAsyncOptions {
  imports?: NonNullable<DynamicModule['imports']>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: unknown[]) => Promise<KeycloakOptions> | KeycloakOptions;
}

/**
 * The single auth module for milestone 1.6+.
 *
 * Registers:
 *   • KeycloakService — fetches OIDC discovery + caches JWKS
 *   • KeycloakAuthGuard — validates JWTs against the cached JWKS
 *
 * Usage:
 *   imports: [
 *     KeycloakModule.forRootAsync({
 *       imports: [ConfigModule],
 *       inject: [ConfigService],
 *       useFactory: (config: ConfigService) => ({
 *         issuerUrl: config.getOrThrow('KEYCLOAK_ISSUER_URL'),
 *         audience: config.getOrThrow('KEYCLOAK_AUDIENCE'),
 *       }),
 *     }),
 *   ],
 */
@Module({})
export class KeycloakModule {
  static forRootAsync(options: KeycloakAsyncOptions): DynamicModule {
    return {
      module: KeycloakModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: KEYCLOAK_OPTIONS,
          inject: options.inject ?? [],
          useFactory: options.useFactory,
        },
        KeycloakService,
        KeycloakAuthGuard,
      ],
      exports: [KeycloakService, KeycloakAuthGuard],
      global: true,
    };
  }

  /**
   * Synchronous variant for services that already have config in scope.
   * Used in tests and the saga executor's bootstrap.
   */
  static forRoot(options: KeycloakOptions): DynamicModule {
    return {
      module: KeycloakModule,
      providers: [
        { provide: KEYCLOAK_OPTIONS, useValue: options },
        KeycloakService,
        KeycloakAuthGuard,
      ],
      exports: [KeycloakService, KeycloakAuthGuard],
      global: true,
    };
  }
}
