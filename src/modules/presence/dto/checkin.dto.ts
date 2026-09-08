import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const checkinSchema = z.object({
  locationId: z.uuid(),
  availableFrom: z.coerce.date(),
  availableUntil: z.coerce.date(),
  // The device's reported position, verified against the location server-side.
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export class CheckinDto extends createZodDto(checkinSchema) {}
