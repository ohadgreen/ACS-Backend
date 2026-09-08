import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localizedTextSchema, supportedLocales } from '../../../common/localized/localized-text';

const localized = localizedTextSchema(supportedLocales());

/** Money crosses the wire as a decimal string; never a float. */
const money = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/);

export const createSessionTypeSchema = z.object({
  code: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  name: localized,
  description: localized.optional(),
  price: money,
  currency: z.string().length(3).default('ILS'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const updateSessionTypeSchema = z.object({
  name: localized.optional(),
  description: localized.optional(),
  price: money.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export class CreateSessionTypeDto extends createZodDto(createSessionTypeSchema) {}
export class UpdateSessionTypeDto extends createZodDto(updateSessionTypeSchema) {}
