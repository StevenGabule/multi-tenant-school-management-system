import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

// Same shape as sis-service / enrollment-service. Verifies JWTs minted
// by the gateway (and forged by the enrollment saga's CrossServiceClient).
// Will be replaced by Keycloak verification in milestone 1.6.

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m', issuer: 'sms-gateway' },
        verifyOptions: { issuer: 'sms-gateway' },
      }),
    }),
  ],
  providers: [JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
