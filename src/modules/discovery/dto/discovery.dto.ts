import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  // Capped: an unbounded radius turns the GIST index into a full scan.
  radius: z.coerce.number().int().positive().max(50_000).optional(),
});

export class NearbyQueryDto extends createZodDto(nearbyQuerySchema) {}
