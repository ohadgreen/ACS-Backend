import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { operators, setupTokens, users, type Operator } from '../../infra/db/schema';
import { hashToken } from '../../common/crypto/opaque-token';

export interface InviteInput {
  email: string;
  displayName: string;
  preferredLocale: string;
  bio?: string;
  gearTags?: string[];
}

@Injectable()
export class OperatorsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** User, profile, and invite token are created together or not at all. */
  async createInvited(
    input: InviteInput,
    setupTokenPlain: string,
    expiresAt: Date,
    adminUserId: string,
  ): Promise<{ operatorId: string; userId: string }> {
    return this.db.transaction(async (tx) => {
      const userId = uuidv7();
      const operatorId = uuidv7();

      await tx.insert(users).values({
        id: userId,
        role: 'operator',
        email: input.email,
        displayName: input.displayName,
        preferredLocale: input.preferredLocale,
        // No password yet: this is the invite waiting room.
        status: 'operator_pending_setup',
      });

      await tx.insert(operators).values({
        id: operatorId,
        userId,
        displayName: input.displayName,
        bio: input.bio ?? null,
        gearTags: input.gearTags ?? [],
      });

      await tx.insert(setupTokens).values({
        id: uuidv7(),
        userId,
        tokenHash: hashToken(setupTokenPlain),
        createdBy: adminUserId,
        expiresAt,
      });

      return { operatorId, userId };
    });
  }

  async findById(id: string): Promise<Operator | undefined> {
    const [row] = await this.db.select().from(operators).where(eq(operators.id, id)).limit(1);
    return row;
  }

  async approve(id: string, adminUserId: string): Promise<void> {
    await this.db
      .update(operators)
      .set({
        approvalStatus: 'approved',
        approvedAt: new Date(),
        approvedBy: adminUserId,
        updatedAt: new Date(),
      })
      .where(eq(operators.id, id));
  }

  async suspend(id: string): Promise<void> {
    await this.db
      .update(operators)
      .set({ approvalStatus: 'suspended', updatedAt: new Date() })
      .where(eq(operators.id, id));
  }

  list(): Promise<Operator[]> {
    return this.db.select().from(operators);
  }

  async updateProfile(
    id: string,
    patch: { displayName?: string; bio?: string | null; gearTags?: string[] },
  ): Promise<Operator> {
    const [row] = await this.db
      .update(operators)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(operators.id, id))
      .returning();
    return row!;
  }
}
