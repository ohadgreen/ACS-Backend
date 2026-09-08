import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const checkinSchema = z.object({
  locationId: z.uuid(),
  // ISO-8601 with an offset, transformed to a Date. `z.coerce.date()` has no
  // JSON Schema representation, and zod throws while the OpenAPI document is
  // being built — which kills the process at boot, not at first request.
  availableFrom: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  availableUntil: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  // The device's reported position, verified against the location server-side.
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export class CheckinDto extends createZodDto(checkinSchema) {}
