import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS } from '../../../infra/redis/redis.module';
import { SMS_PROVIDER, type SmsProvider } from '../../sms/sms-provider';
import { TooManyRequestsError, UnauthorizedError } from '../../../common/errors/domain-error';
import { ErrorCodes } from '../../../common/errors/error-codes';
import { renderOtpMessage } from './otp-templates';
import type { Env } from '../../../infra/config/env.schema';

const DAY_SECONDS = 86_400;

/**
 * Verify, as one atomic step. Doing this in Lua buys three properties that are
 * awkward or impossible from the client:
 *
 *   - HINCRBY never touches the key's TTL, so a failed attempt cannot re-arm
 *     the expiry and hold a code alive indefinitely. Re-arming would turn a
 *     5-attempt cap into an unlimited one.
 *   - The increment is atomic, so concurrent verifies cannot both read the same
 *     counter and slip extra attempts past the cap.
 *   - A missing key returns early instead of HINCRBY creating a fresh hash with
 *     no expiry and leaking a stray key.
 *
 * The stored hash is returned rather than compared here, so the comparison
 * itself happens in Node under timingSafeEqual.
 */
const VERIFY_SCRIPT = `
local stored = redis.call('HGET', KEYS[1], 'hash')
if not stored then
  return {'missing', ''}
end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if attempts > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return {'locked', ''}
end
return {'ok', stored}
`;

@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Every key derives from the already-normalized E.164 number; normalization
  // happens before this service is called.
  private codeKey(phone: string) {
    return `otp:${phone}`;
  }
  private cooldownKey(phone: string) {
    return `otp:cooldown:${phone}`;
  }
  private dailyKey(phone: string) {
    return `otp:daily:${phone}`;
  }

  /**
   * Keyed HMAC, deliberately not a password hash. A six-digit code's security
   * comes from its short TTL and attempt cap, not hash cost; a memory-hard hash
   * would add ~50 ms and ~19 MiB per verify, which an attacker triggers for
   * free. The key still blocks offline brute force of a leaked Redis dump,
   * since 10^6 candidates are useless without it.
   */
  private hash(code: string): string {
    return createHmac('sha256', this.config.get('OTP_SECRET', { infer: true }))
      .update(code)
      .digest('hex');
  }

  async request(phone: string, locale: string): Promise<void> {
    const cooldownSec = this.config.get('OTP_RESEND_COOLDOWN_SEC', { infer: true });
    // SET NX is the cooldown check and the cooldown itself, atomically.
    const claimed = await this.redis.set(this.cooldownKey(phone), '1', 'EX', cooldownSec, 'NX');
    if (claimed === null) {
      const ttl = await this.redis.ttl(this.cooldownKey(phone));
      throw new TooManyRequestsError(
        ErrorCodes.RATE_LIMITED,
        'Wait before requesting another code.',
        { retryAfterSeconds: ttl > 0 ? ttl : cooldownSec },
      );
    }

    const dailyCount = await this.redis.incr(this.dailyKey(phone));
    if (dailyCount === 1) await this.redis.expire(this.dailyKey(phone), DAY_SECONDS);
    if (dailyCount > this.config.get('OTP_DAILY_CAP_PER_PHONE', { infer: true })) {
      const ttl = await this.redis.ttl(this.dailyKey(phone));
      throw new TooManyRequestsError(ErrorCodes.RATE_LIMITED, 'Daily code limit reached.', {
        retryAfterSeconds: ttl > 0 ? ttl : DAY_SECONDS,
      });
    }

    // Full 000000-999999 range. Restricting to 100000-999999 would discard a
    // tenth of the keyspace for nothing.
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const ttlSec = this.config.get('OTP_TTL_SEC', { infer: true });
    const key = this.codeKey(phone);

    // Hash written and TTL armed exactly once. Nothing after this re-arms it.
    await this.redis
      .multi()
      .del(key)
      .hset(key, { hash: this.hash(code), attempts: '0' })
      .expire(key, ttlSec)
      .exec();

    await this.sms.send(phone, renderOtpMessage(locale, code, Math.round(ttlSec / 60)));
  }

  /** True on a correct code. Throws 401 when there is nothing left to verify. */
  async verify(phone: string, code: string): Promise<boolean> {
    const key = this.codeKey(phone);
    const maxAttempts = this.config.get('OTP_MAX_ATTEMPTS', { infer: true });

    const [state, stored] = (await this.redis.eval(
      VERIFY_SCRIPT,
      1,
      key,
      String(maxAttempts),
    )) as [string, string];

    if (state === 'missing') {
      throw new UnauthorizedError(ErrorCodes.OTP_INVALID, 'No active code for this number.');
    }
    if (state === 'locked') {
      throw new UnauthorizedError(
        ErrorCodes.OTP_INVALID,
        'Too many attempts — request a new code.',
      );
    }

    const expected = Buffer.from(stored, 'hex');
    const candidate = Buffer.from(this.hash(code), 'hex');
    const matches = expected.length === candidate.length && timingSafeEqual(expected, candidate);

    if (!matches) return false;

    await this.redis.del(key); // single use
    return true;
  }
}
