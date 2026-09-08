import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

export class LoginDto extends createZodDto(loginSchema) {}
