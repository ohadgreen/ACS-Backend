import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { getTestRedis } from './db.helper';
import { OtpService } from '../../src/modules/auth/otp/otp.service';
import { FakeSmsProvider } from '../../src/modules/sms/fake-sms.provider';

const PHONE = '+972501234567';

const config = (overrides: Record<string, unknown> = {}) =>
  ({
    get: (key: string) =>
      ({
        OTP_SECRET: 'otp-secret-that-is-long-enough-x',
        OTP_TTL_SEC: 300,
        OTP_MAX_ATTEMPTS: 5,
        OTP_RESEND_COOLDOWN_SEC: 30,
        OTP_DAILY_CAP_PER_PHONE: 10,
        DEFAULT_LOCALE: 'he',
        ...overrides,
      })[key],
  }) as unknown as ConfigService<never, true>;

let sms: FakeSmsProvider;
let otp: OtpService;

beforeEach(async () => {
  await getTestRedis().flushdb();
  sms = new FakeSmsProvider();
  otp = new OtpService(getTestRedis(), sms, config());
});

const requestAndRead = async () => {
  await otp.request(PHONE, 'he');
  return sms.lastCodeFor(PHONE)!;
};

describe('OtpService', () => {
  it('sends a six-digit code to the given number', async () => {
    expect(await requestAndRead()).toMatch(/^\d{6}$/);
  });

  it('accepts the correct code', async () => {
    expect(await otp.verify(PHONE, await requestAndRead())).toBe(true);
  });

  it('rejects a wrong code', async () => {
    await requestAndRead();
    expect(await otp.verify(PHONE, '000000')).toBe(false);
  });

  it('never stores the code in plaintext', async () => {
    const code = await requestAndRead();
    const stored = await getTestRedis().hget(`otp:${PHONE}`, 'hash');
    expect(stored).not.toBe(code);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('burns the code on success — it cannot be reused', async () => {
    const code = await requestAndRead();
    expect(await otp.verify(PHONE, code)).toBe(true);
    await expect(otp.verify(PHONE, code)).rejects.toMatchObject({ status: 401 });
  });

  it('does NOT re-arm the TTL on a failed attempt', async () => {
    await requestAndRead();
    const before = await getTestRedis().ttl(`otp:${PHONE}`);
    // Shrink the TTL to simulate time passing, then guess wrong.
    await getTestRedis().expire(`otp:${PHONE}`, 42);
    await otp.verify(PHONE, '000000');
    const after = await getTestRedis().ttl(`otp:${PHONE}`);

    // Re-arming here would let an attacker hold a code alive forever by
    // guessing wrong, turning the attempt cap into an unlimited one.
    expect(after).toBeLessThanOrEqual(42);
    expect(before).toBeGreaterThan(42);
  });

  it('locks the code after the attempt cap', async () => {
    await requestAndRead();
    for (let i = 0; i < 5; i++) await otp.verify(PHONE, '000000');
    await expect(otp.verify(PHONE, '000000')).rejects.toMatchObject({ status: 401 });
    expect(await getTestRedis().exists(`otp:${PHONE}`)).toBe(0);
  });

  it('holds the cap under concurrent verifies', async () => {
    const code = await requestAndRead();
    // Read-modify-write on the counter would let extra attempts through here.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => otp.verify(PHONE, '000000').catch(() => 'rejected')),
    );
    expect(results.filter((r) => r === false).length).toBeLessThanOrEqual(5);
    // The real code is dead too: the key was burned when the cap tripped.
    await expect(otp.verify(PHONE, code)).rejects.toMatchObject({ status: 401 });
  });

  it('enforces the resend cooldown', async () => {
    await otp.request(PHONE, 'he');
    await expect(otp.request(PHONE, 'he')).rejects.toMatchObject({ status: 429 });
    expect(sms.sent).toHaveLength(1);
  });

  it('reports retryAfterSeconds on cooldown', async () => {
    await otp.request(PHONE, 'he');
    await otp.request(PHONE, 'he').catch((e: { details: { retryAfterSeconds: number } }) => {
      expect(e.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(e.details.retryAfterSeconds).toBeLessThanOrEqual(30);
    });
  });

  it('enforces the daily cap even once the cooldown has elapsed', async () => {
    const capped = new OtpService(
      getTestRedis(),
      sms,
      config({ OTP_DAILY_CAP_PER_PHONE: 2, OTP_RESEND_COOLDOWN_SEC: 1 }),
    );
    await capped.request(PHONE, 'he');
    await getTestRedis().del(`otp:cooldown:${PHONE}`);
    await capped.request(PHONE, 'he');
    await getTestRedis().del(`otp:cooldown:${PHONE}`);
    // Every send is billed, so this ceiling is cost control as much as abuse
    // control.
    await expect(capped.request(PHONE, 'he')).rejects.toMatchObject({ status: 429 });
    expect(sms.sent).toHaveLength(2);
  });

  it('rejects a verify for a number with no active code', async () => {
    await expect(otp.verify('+972509999999', '123456')).rejects.toMatchObject({ status: 401 });
  });

  it('leaves no stray key behind after verifying an unknown number', async () => {
    await otp.verify('+972509999999', '123456').catch(() => undefined);
    // HINCRBY on a missing key would create one with no expiry; the Lua script
    // must return before it can.
    expect(await getTestRedis().exists('otp:+972509999999')).toBe(0);
  });

  it('issues a different code each request', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await getTestRedis().flushdb();
      codes.add(await requestAndRead());
    }
    expect(codes.size).toBeGreaterThan(1);
  });

  it('renders the message in the requested locale', async () => {
    await otp.request(PHONE, 'en');
    expect(sms.sent.at(-1)?.message).toContain('ACS code');
    await getTestRedis().flushdb();
    await otp.request(PHONE, 'he');
    expect(sms.sent.at(-1)?.message).toContain('קוד');
  });
});
