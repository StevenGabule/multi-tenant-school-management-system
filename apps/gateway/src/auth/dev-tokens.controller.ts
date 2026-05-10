import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Logger,
  OnModuleInit,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

interface MintTokenBody {
  tenantId: string;
  sub: string;
  roles?: string[];
}

/**
 * **Development-only** JWT minter so we can exercise tenant-scoped routes
 * with curl/HTTP clients without standing up Keycloak. Returns 403 when
 * NODE_ENV === 'production'. Replaced wholesale by Keycloak in milestone 1.6.
 */
@Controller('dev')
export class DevTokensController implements OnModuleInit {
  private readonly logger = new Logger(DevTokensController.name);
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get('NODE_ENV') !== 'production') {
      this.logger.warn(
        'DevTokensController is mounted (POST /api/dev/token). NEVER ship to production.',
      );
    }
  }

  @Post('token')
  @HttpCode(200)
  mint(@Body() body: MintTokenBody) {
    if (this.config.get('NODE_ENV') === 'production') {
      throw new ForbiddenException('dev token endpoint disabled in production');
    }
    if (!body.tenantId || !body.sub) {
      throw new BadRequestException('tenantId and sub are required');
    }
    const token = this.jwt.sign({
      sub: body.sub,
      tenantId: body.tenantId,
      roles: body.roles ?? [],
    });
    return { token };
  }
}
