import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const cancelBookingSchema = z.object({
  reason: z.string().max(500).optional(),
});

export class CancelBookingDto extends createZodDto(cancelBookingSchema) {}
