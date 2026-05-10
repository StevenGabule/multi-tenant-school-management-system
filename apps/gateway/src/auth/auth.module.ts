import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DevTokensController } from './dev-tokens.controller';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        // 15 minutes — short access tokens are the standard.
        // Refresh tokens (rotation, theft detection) come in milestone 1.6.
        signOptions: {
          expiresIn: '15m',
          issuer: 'sms-gateway',
        },
        verifyOptions: {
          issuer: 'sms-gateway',
        },
      }),
    }),
  ],
  controllers: [DevTokensController],
  providers: [JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
