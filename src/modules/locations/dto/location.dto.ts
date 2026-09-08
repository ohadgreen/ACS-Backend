import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localizedTextSchema, supportedLocales } from '../../../common/localized/localized-text';

/**
 * Read from process.env rather than ConfigService: a zod DTO is built when this
 * module is first imported, which happens before Nest's DI container exists.
 * env.schema.ts still owns validation of the value — this only reads it.
 */
const localized = localizedTextSchema(supportedLocales());

/** Slug, not prose: identity must stay stable when the display name changes. */
const slug = z.string().min(1).max(120).regex(/^[a-z0-9-]+$/);

export const createLocationSchema = z.object({
  code: slug,
  siteCode: slug,
  siteName: localized,
  name: localized,
  description: localized.optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/**
 * `code` is deliberately absent: it is the location's stable identity, and
 * bookings, session types and operator schedules are all grouped by it.
 */
export const updateLocationSchema = z.object({
  siteCode: slug.optional(),
  siteName: localized.optional(),
  name: localized.optional(),
  description: localized.optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  isActive: z.boolean().optional(),
});

export class CreateLocationDto extends createZodDto(createLocationSchema) {}
export class UpdateLocationDto extends createZodDto(updateLocationSchema) {}
