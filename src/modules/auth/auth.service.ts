import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { PasswordService } from '../../common/crypto/password.service';
import { ErrorCodes } from '../../common/errors/error-codes';
import { ForbiddenError, UnauthorizedError } from '../../common/errors/domain-error';
import { UsersRepository } from '../users/users.repository';
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

  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionRepository,
  ) {
    this.dummyHash = this.passwords.hash(randomBytes(32).toString('hex'));
  }

  async login(email: string, password: string, deviceInfo: string | null): Promise<TokenPair> {
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
}
