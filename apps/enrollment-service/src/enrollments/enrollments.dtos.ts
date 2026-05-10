import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const StudentInfoSchema = z.object({
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

export const StartEnrollmentSchema = z.object({
  studentInfo: StudentInfoSchema,
  classId: z.string().uuid(),
  parentEmail: z.string().email().optional().nullable(),
});
export class StartEnrollmentDto extends createZodDto(StartEnrollmentSchema) {}
