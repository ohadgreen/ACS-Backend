import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const breakSchema = z.object({
  // Same shape as checkin.dto.ts: `z.coerce.date()` has no JSON Schema form and
  // zod throws while the OpenAPI document is built, killing the process at boot.
  from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  to: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
});

export class BreakDto extends createZodDto(breakSchema) {}
