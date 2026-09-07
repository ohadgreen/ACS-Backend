/**
 * NestJS SMS provider abstraction + SMS4Free implementation + OTP flow sketch.
 *
 * Goal: keep the SMS vendor swappable behind one interface, so switching
 * SMS4Free -> InforU -> Twilio -> Firebase later is a one-file change,
 * not a refactor across the auth module.
 *
 * This is illustrative — wire it into real NestJS module boilerplate,
 * install dependencies (@nestjs/axios or plain fetch, ioredis, argon2/bcrypt),
 * and adjust error handling to your actual conventions before using it.
 */

// ─────────────────────────────────────────────────────────────
// 1. sms-provider.interface.ts — the abstraction every vendor implements
// ─────────────────────────────────────────────────────────────

export interface SmsProvider {
  /** Sends a plain SMS. Throws on failure. */
  send(phoneNumber: string, message: string): Promise<void>;
}

// DI token — inject this, not a concrete class, everywhere you need to send SMS
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');


// ─────────────────────────────────────────────────────────────
// 2. sms4free.provider.ts — direct HTTP call, no npm wrapper dependency
// ─────────────────────────────────────────────────────────────

import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class Sms4FreeProvider implements SmsProvider {
  private readonly logger = new Logger(Sms4FreeProvider.name);
  private readonly endpoint = 'https://api.sms4free.co.il/ApiSMS/v2/SendSMS'; // verify against current SMS4Free docs before relying on this

  constructor(
    private readonly apiKey: string,
    private readonly user: string,
    private readonly pass: string,
    private readonly sender: string,
  ) {}

  async send(phoneNumber: string, message: string): Promise<void> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: this.apiKey,
        user: this.user,
        pass: this.pass,
        sender: this.sender,
        recipient: phoneNumber,
        msg: message,
      }),
    });

    const body = await res.json();

    // SMS4Free returns a numeric status code — map failures to a thrown error
    // so callers (the OTP service below) don't need to know vendor-specific codes.
    if (!res.ok || body.status < 0) {
      this.logger.error(`SMS4Free send failed: ${JSON.stringify(body)}`);
      throw new Error(`SMS send failed (provider status ${body.status})`);
    }
  }
}


// ─────────────────────────────────────────────────────────────
// 3. sms.module.ts — wire the concrete provider behind the token
// ─────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: SMS_PROVIDER,
      useFactory: (config: ConfigService) =>
        new Sms4FreeProvider(
          config.get('SMS4FREE_API_KEY'),
          config.get('SMS4FREE_USER'),
          config.get('SMS4FREE_PASS'),
          config.get('SMS4FREE_SENDER'),
        ),
      inject: [ConfigService],
    },
  ],
  exports: [SMS_PROVIDER],
})
export class SmsModule {}

// Swapping vendors later: write InforUProvider implements SmsProvider,
// change the useFactory above. Nothing outside this file changes.


// ─────────────────────────────────────────────────────────────
// 4. otp.service.ts — the part SMS4Free does NOT give you for free
// ─────────────────────────────────────────────────────────────

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import Redis from 'ioredis';

const OTP_TTL_SECONDS = 5 * 60;      // code expires in 5 minutes
const OTP_MAX_ATTEMPTS = 5;          // lock after repeated wrong guesses
const OTP_RESEND_COOLDOWN_SECONDS = 30; // basic rate limit on resends

@Injectable()
export class OtpService {
  constructor(
    @Inject(SMS_PROVIDER) private readonly smsProvider: SmsProvider,
    private readonly redis: Redis, // inject your Redis client provider here
  ) {}

  async requestOtp(phoneNumber: string): Promise<void> {
    const cooldownKey = `otp:cooldown:${phoneNumber}`;
    if (await this.redis.exists(cooldownKey)) {
      throw new Error('Please wait before requesting another code');
    }

    const code = randomInt(100000, 999999).toString();
    const codeHash = await argon2.hash(code);

    const key = `otp:${phoneNumber}`;
    await this.redis.set(
      key,
      JSON.stringify({ codeHash, attempts: 0 }),
      'EX',
      OTP_TTL_SECONDS,
    );
    await this.redis.set(cooldownKey, '1', 'EX', OTP_RESEND_COOLDOWN_SECONDS);

    await this.smsProvider.send(
      phoneNumber,
      `Your verification code is ${code}. Expires in 5 minutes.`,
    );
  }

  async verifyOtp(phoneNumber: string, submittedCode: string): Promise<boolean> {
    const key = `otp:${phoneNumber}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new UnauthorizedException('Code expired or not requested');

    const { codeHash, attempts } = JSON.parse(raw);

    if (attempts >= OTP_MAX_ATTEMPTS) {
      await this.redis.del(key);
      throw new UnauthorizedException('Too many attempts — request a new code');
    }

    const isValid = await argon2.verify(codeHash, submittedCode);

    if (!isValid) {
      await this.redis.set(
        key,
        JSON.stringify({ codeHash, attempts: attempts + 1 }),
        'EX',
        OTP_TTL_SECONDS, // preserve remaining TTL in a real implementation
      );
      return false;
    }

    await this.redis.del(key); // one-time use — burn it on success
    return true;
    // Caller (your auth controller) mints the access/refresh token pair
    // from §8 of the design doc here — OTP verification success is the
    // trigger for issuing your own JWT, not Firebase's or anyone else's.
  }
}


// ─────────────────────────────────────────────────────────────
// 5. otp.controller.ts — the two endpoints the mobile app calls
// ─────────────────────────────────────────────────────────────

import { Body, Controller, Post } from '@nestjs/common';

@Controller('auth/otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @Post('start')
  async start(@Body('phoneNumber') phoneNumber: string) {
    await this.otpService.requestOtp(phoneNumber);
    return { status: 'sent' };
  }

  @Post('verify')
  async verify(
    @Body('phoneNumber') phoneNumber: string,
    @Body('code') code: string,
  ) {
    const valid = await this.otpService.verifyOtp(phoneNumber, code);
    if (!valid) return { status: 'invalid' };

    // TODO: issue access token (15min) + refresh token (stored, revocable)
    // per the auth design in §8 — omitted here since it's already covered there.
    return { status: 'verified' /*, accessToken, refreshToken */ };
  }
}