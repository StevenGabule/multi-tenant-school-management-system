import { Controller, Get, HttpCode } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('livez')
  @HttpCode(200)
  livez() {
    return { status: 'alive', uptime: Math.round(process.uptime()) };
  }

  // BFF readiness is the union of all downstreams, but per Phase 1
  // observability scope we keep readyz lightweight: it returns ready as
  // soon as the process is up. Milestone 1.8 may extend it to probe
  // KEYCLOAK_ISSUER_URL discovery + Redis.
  @Get('readyz')
  @HttpCode(200)
  readyz() {
    return { status: 'ready' };
  }
}
