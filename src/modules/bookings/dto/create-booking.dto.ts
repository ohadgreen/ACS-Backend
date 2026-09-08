import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createBookingSchema = z.object({
  locationId: z.uuid(),
  // Not `z.coerce.date()`: it has no JSON Schema form and zod throws while the
  // OpenAPI document is built, which crashes the process at boot.
  startAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  locationSessionTypeId: z.uuid(),
});

export class CreateBookingDto extends createZodDto(createBookingSchema) {}
