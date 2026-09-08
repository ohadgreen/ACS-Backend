import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { PasswordService } from '../../common/crypto/password.service';
import { ErrorCodes } from '../../common/errors/error-codes';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../common/errors/domain-error';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service';
import { OtpService } from './otp/otp.service';
import { normalizePhone, phoneCountry } from './phone';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import { UsersRepository, normalizeEmail } from '../users/users.repository';
import { SessionRepository } from './session.repository';
import { TokenService } from './token.service';
import type { Role } from './auth.types';
import type { User } from '../../infra/db/schema';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  /**
   * A real argon2id hash of a value nobody knows, computed once at boot. When
   * the email is unknown we still verify against this, so response timing does
   * not distinguish "no such account" from "wrong password".
   */
  private readonly dummyHash: Promise<string>;

  /**
   * The locale chosen at request time, remembered until verification — the
   * verify call carries no locale of its own, and the user row created there
   * needs one.
   */
  private readonly pendingLocale = new Map<string, string>();

  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionRepository,
    private readonly otp: OtpService,
    private readonly limiter: RateLimiterService,
    // AppConfig is a type alias, so emitDecoratorMetadata records nothing for
    // it and Nest cannot infer the token. Inject the real class explicitly.
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {
    this.dummyHash = this.passwords.hash(randomBytes(32).toString('hex'));
  }

  async login(
    email: string,
    password: string,
    deviceInfo: string | null,
    ip: string,
  ): Promise<TokenPair> {
    // Per-email and per-IP both matter: the first blocks guessing one account,
    // the second blocks spraying one password across many.
    const emailKey = normalizeEmail(email);
    await this.limiter.consume('login:email:' + emailKey, 5, 900);
    await this.limiter.consume('login:ip:' + ip, 30, 900);

    const user = await this.usersRepo.findByEmail(email);
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const ok = await this.passwords.verify(hash, password);

    if (!user || !ok) {
      // One code for both causes: revealing which one failed would let an
      // attacker enumerate accounts.
      throw new UnauthorizedError(
        ErrorCodes.INVALID_CREDENTIALS,
        'Email or password is incorrect.',
      );
    }
    if (user.status !== 'active') {
      throw new ForbiddenError(ErrorCodes.ACCOUNT_SUSPENDED, 'This account cannot sign in.', {
        status: user.status,
      });
    }

    // Clear the per-email counter on success, so a legitimate user is not
    // locked out by their own earlier typos.
    await this.limiter.reset('login:email:' + emailKey);

    return this.issuePair(user, null, deviceInfo);
  }

  /**
   * Builds the claim set and a fresh session. `operatorId` is resolved here so
   * downstream guards never have to hit the database for it.
   *
   * Note this does NOT gate on operators.approval_status: an operator may be
   * active but not yet approved, and must be able to log in and complete their
   * profile while they wait. Approval is enforced where it matters — check-in,
   * and every token refresh.
   */
  async issuePair(
    user: User,
    familyId: string | null,
    deviceInfo: string | null,
  ): Promise<TokenPair> {
    const role = user.role as Role;
    const operatorId =
      role === 'operator' ? (await this.usersRepo.findOperatorByUserId(user.id))?.id : undefined;

    const session = await this.sessions.issue(user.id, familyId, deviceInfo);

    return {
      accessToken: this.tokens.issueAccessToken({
        sub: user.id,
        role,
        operatorId,
        jti: uuidv7(),
      }),
      refreshToken: session.token,
    };
  }
  /**
   * Three steps, in this order — the order IS the security property.
   *
   * 1. Replay check. A token already revoked or already rotated is a theft
   *    signal, so the entire family dies, not just the presented row.
   * 2. Re-check current status. This is what actually enforces 'approved
   *    operators only' on an ongoing basis; a login-time check alone would let
   *    a suspended operator refresh forever.
   * 3. Only then rotate.
   */
  async refresh(refreshToken: string, deviceInfo: string | null): Promise<TokenPair> {
    const row = await this.sessions.findByToken(refreshToken);
    if (!row) {
      throw new UnauthorizedError(ErrorCodes.REFRESH_TOKEN_INVALID, 'Unknown refresh token.');
    }

    if (row.revokedAt !== null || row.replacedBy !== null) {
      await this.sessions.revokeFamily(row.familyId);
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_REPLAYED,
        'Refresh token was already used; the session family has been revoked.',
      );
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError(ErrorCodes.REFRESH_TOKEN_INVALID, 'Refresh token expired.');
    }

    const user = await this.usersRepo.findById(row.userId);
    if (!user) {
      throw new UnauthorizedError(ErrorCodes.REFRESH_TOKEN_INVALID, 'Unknown refresh token.');
    }
    if (user.status !== 'active') {
      throw new ForbiddenError(ErrorCodes.ACCOUNT_SUSPENDED, 'This account cannot sign in.', {
        status: user.status,
      });
    }

    let operatorId: string | undefined;
    if (user.role === 'operator') {
      const operator = await this.usersRepo.findOperatorByUserId(user.id);
      if (operator?.approvalStatus !== 'approved') {
        throw new ForbiddenError(
          ErrorCodes.OPERATOR_NOT_APPROVED,
          'Operator is not approved to work.',
          { approvalStatus: operator?.approvalStatus ?? 'missing' },
        );
      }
      operatorId = operator.id;
    }

    const rotated = await this.sessions.rotate(row.id, user.id, row.familyId, deviceInfo);

    return {
      accessToken: this.tokens.issueAccessToken({
        sub: user.id,
        role: user.role as Role,
        operatorId,
        jti: uuidv7(),
      }),
      refreshToken: rotated.token,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const row = await this.sessions.findByToken(refreshToken);
    if (row) await this.sessions.revokeById(row.id);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId);
  }
  async requestOtp(rawPhone: string, locale: string | undefined, ip: string): Promise<void> {
    const phone = normalizePhone(rawPhone);

    // Gate before spending anything: the MVP gateway serves one country, and
    // reporting success for an undeliverable number is the worst outcome —
    // the customer waits for an SMS that never arrives, and support has
    // nothing to go on.
    const allowed = requireEnv(this.config, 'SMS_SUPPORTED_COUNTRIES');
    const country = phoneCountry(rawPhone);
    if (!country || !allowed.includes(country)) {
      throw new ValidationError(
        ErrorCodes.PHONE_COUNTRY_UNSUPPORTED,
        'We cannot send codes to that country yet.',
        { field: 'phone', country: country ?? null, supported: allowed },
      );
    }

    // Per-IP limit lives here; the per-phone cooldown and daily cap live in
    // OtpService, which owns the code's lifecycle.
    await this.limiter.consume(`otp:ip:${ip}`, 20, 3600);

    const chosen = locale ?? requireEnv(this.config, 'DEFAULT_LOCALE');
    await this.otp.request(phone, chosen);
    this.pendingLocale.set(phone, chosen);
  }

  async verifyOtp(rawPhone: string, code: string, deviceInfo: string | null): Promise<TokenPair> {
    const phone = normalizePhone(rawPhone);

    // Attempt counting and lockout are inside OtpService: a wrong code returns
    // false, while an absent or burned code throws 401 directly.
    if (!(await this.otp.verify(phone, code))) {
      throw new UnauthorizedError(ErrorCodes.OTP_INVALID, 'The verification code is not valid.');
    }

    const locale =
      this.pendingLocale.get(phone) ?? requireEnv(this.config, 'DEFAULT_LOCALE');
    this.pendingLocale.delete(phone);

    const user = await this.usersRepo.upsertCustomerByPhone(phone, locale);
    return this.issuePair(user, null, deviceInfo);
  }
}
