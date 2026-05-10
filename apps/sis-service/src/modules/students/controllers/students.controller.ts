import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import { CreateStudentUseCase } from '../application/create-student.use-case';
import {
  FindStudentByIdUseCase,
  ListStudentsUseCase,
} from '../application/find-student.use-case';
import {
  RestoreStudentUseCase,
  SoftDeleteStudentUseCase,
} from '../application/soft-delete-student.use-case';
import { UpdateStudentUseCase } from '../application/update-student.use-case';
import {
  CreateStudentDto,
  ListStudentsQueryDto,
  UpdateStudentDto,
} from './students.dtos';
import { toStudentResponse } from './student.presenter';

/**
 * Thin controller. Each handler:
 *   1. Validates body/query via the Zod-derived DTO (nestjs-zod
 *      ZodValidationPipe runs globally, see main.ts).
 *   2. Delegates to ONE application use case.
 *   3. Maps the domain Student to the wire StudentResponse shape.
 *
 * Authorization: JwtAuthGuard validates the JWT, resolves the tenant
 * via the registry, and pushes tenantId into CLS. The repository's
 * withCurrentTenant reads it back.
 */
@ApiTags('students')
@Controller('students')
@UseGuards(JwtAuthGuard)
export class StudentsController {
  constructor(
    private readonly create: CreateStudentUseCase,
    private readonly findById: FindStudentByIdUseCase,
    private readonly listStudents: ListStudentsUseCase,
    private readonly update: UpdateStudentUseCase,
    private readonly softDelete: SoftDeleteStudentUseCase,
    private readonly restore: RestoreStudentUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async createOne(@Body() body: CreateStudentDto) {
    const student = await this.create.execute(body);
    return toStudentResponse(student);
  }

  @Get()
  async list(@Query() query: ListStudentsQueryDto) {
    const students = await this.listStudents.execute({
      search: query.search,
      includeDeleted: query.includeDeleted,
      limit: query.limit,
    });
    return students.map(toStudentResponse);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const student = await this.findById.execute(id);
    return toStudentResponse(student);
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: UpdateStudentDto) {
    const student = await this.update.execute(id, body);
    return toStudentResponse(student);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.softDelete.execute(id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  async restoreOne(@Param('id') id: string) {
    await this.restore.execute(id);
    const student = await this.findById.execute(id);
    return toStudentResponse(student);
  }
}
