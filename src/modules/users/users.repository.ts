import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { operators, users, type Operator, type User } from '../../infra/db/schema';

/** Emails are stored lowercased and trimmed; every lookup normalizes first. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async findByEmail(email: string): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  }

  async findByPhone(phone: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.phone, phone)).limit(1);
    return row;
  }

  async findOperatorByUserId(userId: string): Promise<Operator | undefined> {
    const [row] = await this.db
      .select()
      .from(operators)
      .where(eq(operators.userId, userId))
      .limit(1);
    return row;
  }

  /**
   * Customers are created on first successful verification. display_name stays
   * null — the OTP flow supplies no name; the client prompts for one later.
   */
  async upsertCustomerByPhone(phone: string, locale: string): Promise<User> {
    const existing = await this.findByPhone(phone);
    if (existing) {
      const [updated] = await this.db
        .update(users)
        .set({ preferredLocale: locale, phoneVerifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, existing.id))
        .returning();
      return updated!;
    }

    const [created] = await this.db
      .insert(users)
      .values({
        id: uuidv7(),
        role: 'customer',
        phone,
        preferredLocale: locale,
        phoneVerifiedAt: new Date(),
      })
      .returning();
    return created!;
  }
}

