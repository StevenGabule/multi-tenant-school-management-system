import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ConfirmEnrollmentSchema = z.object({
  studentId: z.string().uuid(),
  classId: z.string().uuid(),
});
export class ConfirmEnrollmentDto extends createZodDto(
  ConfirmEnrollmentSchema,
) {}
