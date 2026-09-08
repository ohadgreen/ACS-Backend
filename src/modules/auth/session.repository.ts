import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import ms, { type StringValue } from 'ms';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { refreshTokens, type RefreshToken } from '../../infra/db/schema';
import { generateOpaqueToken, hashToken } from '../../common/crypto/opaque-token';
import type { Env } from '../../infra/config/env.schema';

export const REFRESH_TTL_MS = Symbol('REFRESH_TTL_MS');

@Injectable()
export class SessionRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REFRESH_TTL_MS) private readonly ttlMs: number,
  ) {}

  async issue(userId: string, familyId: string | null, deviceInfo: string | null) {
    const token = generateOpaqueToken();
    const id = uuidv7();
    const family = familyId ?? uuidv7();

    await this.db.insert(refreshTokens).values({
      id,
      userId,
      familyId: family,
      tokenHash: hashToken(token),
      deviceInfo,
      expiresAt: new Date(Date.now() + this.ttlMs),
    });

    // The plaintext is returned to the caller and never persisted anywhere.
    return { token, id, familyId: family };
  }

  async findByToken(token: string): Promise<RefreshToken | undefined> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(token)))
      .limit(1);
    return row;
  }

  /** Issues the successor and points the predecessor at it, in one transaction. */
  async rotate(oldId: string, userId: string, familyId: string, deviceInfo: string | null) {
    return this.db.transaction(async (tx) => {
      const token = generateOpaqueToken();
      const id = uuidv7();

      await tx.insert(refreshTokens).values({
        id,
        userId,
        familyId,
        tokenHash: hashToken(token),
        deviceInfo,
        expiresAt: new Date(Date.now() + this.ttlMs),
      });
      await tx.update(refreshTokens).set({ replacedBy: id }).where(eq(refreshTokens.id, oldId));

      return { token, id };
    });
  }

  /**
   * A replayed token is a theft signal, so the whole family dies — not just the
   * presented row. The isNull guard keeps an already-revoked row's original
   * timestamp, which matters for working out when a compromise started.
   */
  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  async revokeById(id: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}

export function refreshTtlProvider() {
  return {
    provide: REFRESH_TTL_MS,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>) =>
      ms(config.get('REFRESH_TOKEN_TTL', { infer: true }) as StringValue),
  };
}
