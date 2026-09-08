import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const setupSchema = z.object({
  password: z.string().min(12).max(1024),
});

export class SetupDto extends createZodDto(setupSchema) {}
