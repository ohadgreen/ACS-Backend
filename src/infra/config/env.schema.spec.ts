import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema';

const required = {
  DATABASE_URL: 'postgres://acs:acs@localhost:5432/acs',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  OTP_SECRET: 'y'.repeat(32),
  SMS_PROVIDER: 'fake',
};

describe('envSchema', () => {
  it('applies documented defaults', () => {
    const env = envSchema.parse(required);
    expect(env.BUSINESS_TIMEZONE).toBe('Asia/Jerusalem');
    expect(env.SLOT_DURATION_MIN).toBe(15);
    expect(env.DISCOVERY_RADIUS_M).toBe(300);
    expect(env.CHECKIN_LOCATION_TOLERANCE_M).toBe(150);
    expect(env.BOOKING_LEAD_TIME_MIN).toBe(5);
    expect(env.LATE_CANCELLATION_MIN).toBe(60);
    expect(env.DEFAULT_LOCALE).toBe('he');
    expect(env.SUPPORTED_LOCALES).toEqual(['en', 'he']);
    expect(env.OTP_TTL_SEC).toBe(300);
    expect(env.OTP_MAX_ATTEMPTS).toBe(5);
    expect(env.OTP_RESEND_COOLDOWN_SEC).toBe(30);
    expect(env.OTP_DAILY_CAP_PER_PHONE).toBe(10);
    expect(env.SMS_SUPPORTED_COUNTRIES).toEqual(['IL']);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL, ...rest } = required;
    expect(() => envSchema.parse(rest)).toThrow();
  });

  it('rejects a JWT_SECRET under 32 characters', () => {
    expect(() => envSchema.parse({ ...required, JWT_SECRET: 'short' })).toThrow();
  });

  it('rejects a missing OTP_SECRET', () => {
    const { OTP_SECRET, ...rest } = required;
    expect(() => envSchema.parse(rest)).toThrow();
  });

  it('coerces numeric strings from the environment', () => {
    const env = envSchema.parse({ ...required, DISCOVERY_RADIUS_M: '500' });
    expect(env.DISCOVERY_RADIUS_M).toBe(500);
  });

  it('rejects a DEFAULT_LOCALE outside SUPPORTED_LOCALES', () => {
    expect(() =>
      envSchema.parse({ ...required, SUPPORTED_LOCALES: 'en', DEFAULT_LOCALE: 'he' }),
    ).toThrow();
  });

  it('requires SMS4Free credentials when that provider is selected', () => {
    // Missing credentials must fail at boot, not on the first login attempt.
    expect(() => envSchema.parse({ ...required, SMS_PROVIDER: 'sms4free' })).toThrow();
  });

  it('accepts SMS4Free once every credential is present', () => {
    const env = envSchema.parse({
      ...required,
      SMS_PROVIDER: 'sms4free',
      SMS4FREE_API_KEY: 'k',
      SMS4FREE_USER: 'u',
      SMS4FREE_PASS: 'p',
      SMS4FREE_SENDER: 'ACS',
    });
    expect(env.SMS_PROVIDER).toBe('sms4free');
  });

  it('rejects an unknown SMS provider name', () => {
    expect(() => envSchema.parse({ ...required, SMS_PROVIDER: 'carrier-pigeon' })).toThrow();
  });
});
