import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ms, { type StringValue } from 'ms';
import { OperatorsRepository, type InviteInput } from './operators.repository';
import { UsersRepository, normalizeEmail } from '../users/users.repository';
import { SessionRepository } from '../auth/session.repository';
import { generateOpaqueToken } from '../../common/crypto/opaque-token';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';

@Injectable()
export class OperatorsService {
  constructor(
    private readonly repo: OperatorsRepository,
    private readonly usersRepo: UsersRepository,
    private readonly sessions: SessionRepository,
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  async invite(
    input: Omit<InviteInput, 'preferredLocale'> & { preferredLocale?: string },
    adminUserId: string,
  ) {
    const email = normalizeEmail(input.email);
    if (await this.usersRepo.findByEmail(email)) {
      throw new ConflictError(ErrorCodes.VALIDATION_FAILED, 'That email already exists.', {
        field: 'email',
      });
    }

    const setupToken = generateOpaqueToken();
    const ttl = ms(requireEnv(this.config, 'SETUP_TOKEN_TTL') as StringValue);
    const { operatorId } = await this.repo.createInvited(
      {
        ...input,
        email,
        preferredLocale: input.preferredLocale ?? requireEnv(this.config, 'DEFAULT_LOCALE'),
      },
      setupToken,
      new Date(Date.now() + ttl),
      adminUserId,
    );

    // Emailing the link is sub-project #3's notification work; returning the
    // token lets an admin deliver it out of band until then.
    return { operatorId, setupToken };
  }

  async approve(operatorId: string, adminUserId: string): Promise<void> {
    await this.requireOperator(operatorId);
    await this.repo.approve(operatorId, adminUserId);
  }

  /**
   * Suspension must revoke refresh tokens immediately. The access token stays
   * valid until it expires (<=15 min), which the design accepts explicitly in
   * exchange for not running a token blocklist.
   */
  async suspend(operatorId: string): Promise<void> {
    const operator = await this.requireOperator(operatorId);
    await this.repo.suspend(operatorId);
    await this.sessions.revokeAllForUser(operator.userId);
  }

  list() {
    return this.repo.list();
  }

  async getOwnProfile(operatorId: string) {
    return this.requireOperator(operatorId);
  }

  async updateOwnProfile(
    operatorId: string,
    patch: { displayName?: string; bio?: string | null; gearTags?: string[] },
  ) {
    await this.requireOperator(operatorId);
    return this.repo.updateProfile(operatorId, patch);
  }

  private async requireOperator(operatorId: string) {
    const operator = await this.repo.findById(operatorId);
    if (!operator) {
      throw new NotFoundError(ErrorCodes.OPERATOR_NOT_FOUND, 'No such operator.');
    }
    return operator;
  }
}
