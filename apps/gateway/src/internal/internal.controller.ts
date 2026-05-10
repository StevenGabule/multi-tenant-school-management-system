import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantRegistryService } from '@org/tenant-registry';

/**
 * Operator-facing introspection endpoints. Disabled in production.
 *
 * Until milestone 1.8 wires the OTel metrics SDK + Prometheus, these
 * endpoints (and the periodic log roll-up in TenantRegistryService) are
 * how we eyeball cache hit rate. Useful when triaging "why is gateway
 * slow?" questions: high http=% means we're hammering tenant-service,
 * high unavailable=% means the registry is sick.
 */
@Controller('_internal')
export class InternalController {
  constructor(
    private readonly registry: TenantRegistryService,
    private readonly config: ConfigService,
  ) {}

  @Get('registry-stats')
  registryStats() {
    if (this.config.get('NODE_ENV') === 'production') {
      throw new NotFoundException();
    }
    return this.registry.getStats();
  }
}
