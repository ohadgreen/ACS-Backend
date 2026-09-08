import { z } from 'zod';

/**
 * Comma-separated list. `.default()` must come BEFORE `.transform()`: in zod 4
 * a default applies to the schema's input, so defaulting after the transform
 * would type the fallback as the already-split array.
 */
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    JWT_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL: z.string().default('30d'),
    SETUP_TOKEN_TTL: z.string().default('72h'),

    // SMS transport. Credentials are optional so the 'fake' provider boots in
    // development and CI without them; the refinement below enforces them when
    // a real gateway is selected.
    SMS_PROVIDER: z.enum(['sms4free', 'fake']).default('sms4free'),
    SMS4FREE_API_KEY: z.string().optional(),
    SMS4FREE_USER: z.string().optional(),
    SMS4FREE_PASS: z.string().optional(),
    SMS4FREE_SENDER: z.string().optional(),
    SMS_SUPPORTED_COUNTRIES: csv('IL'),

    // OTP protocol, owned in-house. OTP_SECRET is deliberately separate from
    // JWT_SECRET so a leak in either subsystem does not compromise both.
    OTP_SECRET: z.string().min(32),
    OTP_TTL_SEC: z.coerce.number().int().positive().default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().positive().default(30),
    OTP_DAILY_CAP_PER_PHONE: z.coerce.number().int().positive().default(10),

    BUSINESS_TIMEZONE: z.string().default('Asia/Jerusalem'),
    SUPPORTED_LOCALES: csv('en,he'),
    DEFAULT_LOCALE: z.string().default('he'),

    SLOT_DURATION_MIN: z.coerce.number().int().positive().default(15),
    DISCOVERY_RADIUS_M: z.coerce.number().int().positive().default(300),
    CHECKIN_LOCATION_TOLERANCE_M: z.coerce.number().int().positive().default(150),
    BOOKING_LEAD_TIME_MIN: z.coerce.number().int().nonnegative().default(5),
    LATE_CANCELLATION_MIN: z.coerce.number().int().nonnegative().default(60),
  })
  .superRefine((env, ctx) => {
    if (!env.SUPPORTED_LOCALES.includes(env.DEFAULT_LOCALE)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEFAULT_LOCALE'],
        message: 'DEFAULT_LOCALE must be one of SUPPORTED_LOCALES',
      });
    }

    // Fail at boot rather than on the first customer's login attempt.
    if (env.SMS_PROVIDER === 'sms4free') {
      const credentials = [
        'SMS4FREE_API_KEY',
        'SMS4FREE_USER',
        'SMS4FREE_PASS',
        'SMS4FREE_SENDER',
      ] as const;
      for (const key of credentials) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when SMS_PROVIDER is "sms4free"`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
