import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const supported = (process.env.SUPPORTED_LOCALES ?? 'en,he').split(',').map((s) => s.trim());

export const otpRequestSchema = z.object({
  phone: z.string().min(5).max(32),
  locale: z.enum(supported as [string, ...string[]]).optional(),
});

export const otpVerifySchema = z.object({
  phone: z.string().min(5).max(32),
  code: z.string().regex(/^\d{6}$/),
});

export class OtpRequestDto extends createZodDto(otpRequestSchema) {}
export class OtpVerifyDto extends createZodDto(otpVerifySchema) {}
