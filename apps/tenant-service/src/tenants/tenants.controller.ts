import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { TenantsService } from './tenants.service';
import type {
  CreateTenantInput,
  UpdateTenantInput,
} from './tenants.service';

const SLUG_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: CreateTenantInput) {
    if (!body?.name || !body?.slug) {
      throw new BadRequestException('name and slug are required');
    }
    if (!SLUG_RE.test(body.slug)) {
      throw new BadRequestException(
        'slug must be lowercase alphanumeric/hyphens, 3-64 chars, start with a letter',
      );
    }
    return this.tenants.create(body);
  }

  @Get()
  list() {
    return this.tenants.list();
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    const t = await this.tenants.findById(id);
    if (!t) throw new NotFoundException(`tenant not found: ${id}`);
    return t;
  }

  @Get('by-slug/:slug')
  async findBySlug(@Param('slug') slug: string) {
    const t = await this.tenants.findBySlug(slug);
    if (!t) throw new NotFoundException(`tenant not found: ${slug}`);
    return t;
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() patch: UpdateTenantInput) {
    return this.tenants.update(id, patch);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.tenants.suspend(id, body?.reason);
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(@Param('id') id: string) {
    return this.tenants.activate(id);
  }
}
