import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Light input validation here. Domain-level invariants (e.g. DOB in past)
// are enforced by the value-object factories in the use case — the layer
// boundary is where validation makes sense, but the *truth* of "what's
// valid" lives in the domain.

export const CreateStudentSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  middleName: z.string().trim().min(1).max(100).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO date YYYY-MM-DD'),
  externalId: z.string().trim().min(1).max(64).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().trim().min(7).max(40).optional().nullable(),
  gender: z.string().trim().min(1).max(32).optional().nullable(),
});
export class CreateStudentDto extends createZodDto(CreateStudentSchema) {}

export const UpdateStudentSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  middleName: z.string().trim().min(1).max(100).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().trim().min(7).max(40).optional().nullable(),
  externalId: z.string().trim().min(1).max(64).optional().nullable(),
});
export class UpdateStudentDto extends createZodDto(UpdateStudentSchema) {}

export const ListStudentsQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  includeDeleted: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === 'true' || v === true),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export class ListStudentsQueryDto extends createZodDto(ListStudentsQuerySchema) {}

// Response shape — what we send back over the wire. Kept separate from
// the domain entity so renames in the entity don't silently change the
// API contract.
export const StudentResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  externalId: z.string().nullable(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  dateOfBirth: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  gender: z.string().nullable(),
  isDeleted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export class StudentResponseDto extends createZodDto(StudentResponseSchema) {}
