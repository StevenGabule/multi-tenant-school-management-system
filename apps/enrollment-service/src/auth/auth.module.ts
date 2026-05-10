import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { KeycloakModule } from '@org/auth-keycloak';

// Auth backbone for milestone 1.6+. KeycloakModule provides the
// validation guard for INCOMING requests; JwtModule remains because the
// saga's CrossServiceClient is being refactored separately to fetch
// service tokens from Keycloak via client_credentials (step 8) — until
// then it still needs JwtModule.

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
    // Temporary: still used by CrossServiceClient until Step 8 of 1.6.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '60s', issuer: 'sms-gateway' },
      }),
    }),
  ],
  exports: [JwtModule],
})
export class AuthModule {}
