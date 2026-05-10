import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KeycloakModule } from '@org/auth-keycloak';

// Auth backbone — pure Keycloak now. JwtModule + JWT_SECRET-forging
// removed; CrossServiceClient fetches service tokens via Keycloak's
// client_credentials grant (see sagas/cross-service.client.ts).

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
