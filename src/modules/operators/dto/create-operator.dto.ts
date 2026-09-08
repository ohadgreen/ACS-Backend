import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const supported = (process.env.SUPPORTED_LOCALES ?? 'en,he').split(',').map((s) => s.trim());

export const createOperatorSchema = z.object({
  email: z.email().max(320),
  displayName: z.string().min(1).max(120),
  preferredLocale: z.enum(supported as [string, ...string[]]).optional(),
  bio: z.string().max(2000).optional(),
  gearTags: z.array(z.string().max(60)).max(20).optional(),
});

export class CreateOperatorDto extends createZodDto(createOperatorSchema) {}
