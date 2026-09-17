import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { deviceTokens } from '../../infra/db/schema';

@Injectable()
export class DevicesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Registering is idempotent, because the client cannot know whether it has
   * already reported its current token — the OS may rotate it between launches,
   * so the app registers on every foreground and the server absorbs it.
   */
  async register(userId: string, token: string, platform: 'ios' | 'android'): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      // One handset, two users: customer A logs out, customer B logs in, and B
      // presents the token bound to A. Without this, A's booking notifications
      // arrive on B's phone.
      await tx
        .update(deviceTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(deviceTokens.token, token),
            isNull(deviceTokens.revokedAt),
            ne(deviceTokens.userId, userId),
          ),
        );

      await tx
        .insert(deviceTokens)
        .values({ id: uuidv7(), userId, token, platform, createdAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: deviceTokens.token,
          // Repeated verbatim from the index predicate so Postgres can infer
          // the partial index. Note this is `targetWhere` — onConflictDoNothing
          // spells the same thing `where`.
          targetWhere: sql`revoked_at IS NULL`,
          set: { lastSeenAt: now, platform },
        });
    });
  }

  /** False when the caller holds no such active token — the controller turns that into a 404. */
  async revoke(userId: string, token: string): Promise<boolean> {
    const rows = await this.db
      .update(deviceTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(deviceTokens.userId, userId),
          eq(deviceTokens.token, token),
          isNull(deviceTokens.revokedAt),
        ),
      )
      .returning({ id: deviceTokens.id });
    return rows.length > 0;
  }

  async listActiveFor(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)));
    return rows.map((r) => r.token);
  }

  /** Used by the push processor to reap tokens the transport reported dead. */
  async revokeTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.db
      .update(deviceTokens)
      .set({ revokedAt: new Date() })
      .where(and(inArray(deviceTokens.token, tokens), isNull(deviceTokens.revokedAt)));
  }
}
