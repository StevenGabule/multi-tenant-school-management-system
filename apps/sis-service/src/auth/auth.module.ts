import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KeycloakModule } from '@org/auth-keycloak';

// Auth backbone for milestone 1.6+. Wraps the shared @org/auth-keycloak
// lib for sis-service. Same shape across every service in the workspace.

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
})
export class AuthModule {}
