import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Deliberately narrow. approvalStatus and presence are NOT editable here —
 * approval is an admin act, and presence is derived from check-in and booking
 * transitions. zod objects strip unknown keys by default, so a client that
 * PATCHes a whole profile object back gets the extra fields ignored rather
 * than a 422.
 */
export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  bio: z.string().max(2000).nullable().optional(),
  gearTags: z.array(z.string().max(60)).max(20).optional(),
});

export class UpdateProfileDto extends createZodDto(updateProfileSchema) {}
