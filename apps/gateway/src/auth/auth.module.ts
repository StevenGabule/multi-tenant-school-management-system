import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KeycloakModule } from '@org/auth-keycloak';

// Auth backbone for milestone 1.6+. Wraps the shared @org/auth-keycloak
// lib for the gateway. The hand-rolled JwtAuthGuard + JwtModule from
// milestone 1.1 are gone — superseded by the OIDC validation pipeline.

@Module({
  imports: [
    KeycloakModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        issuerUrl: config.getOrThrow<string>('KEYCLOAK_ISSUER_URL'),
        audience: config.getOrThrow<string>('KEYCLOAK_AUDIENCE'),
      }),
    }),
  ],
  // KeycloakModule is global, so its providers (KeycloakAuthGuard,
  // KeycloakService) are automatically available app-wide. Nothing else
  // to export.
})
export class AuthModule {}
