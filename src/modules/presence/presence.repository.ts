import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { locations, operatorCheckins, operatorSlots, operators } from '../../infra/db/schema';
import { makePoint } from '../../infra/db/types';

@Injectable()
export class PresenceRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Physical-presence verification — the operator must actually be there. */
  async isWithinTolerance(
    locationId: string,
    lat: number,
    lng: number,
    meters: number,
  ): Promise<boolean> {
    const res = await this.db.execute<{ ok: boolean }>(sql`
      SELECT ST_DWithin(${locations.geog}, ${makePoint(lng, lat)}, ${meters}) AS ok
      FROM ${locations} WHERE ${locations.id} = ${locationId}
    `);
    return res.rows[0]?.ok === true;
  }

  /**
   * Check-in and its slots are created together or not at all. Inserting with
   * ON CONFLICT DO NOTHING and then comparing counts lets us report exactly
   * which ticks collided instead of failing opaquely, and throwing out of the
   * callback aborts the transaction so a conflict leaves no partial check-in
   * and no stale 'online' presence behind.
   */
  async createCheckinWithSlots(input: {
    operatorId: string;
    locationId: string;
    availableFrom: Date;
    availableUntil: Date;
    lat: number;
    lng: number;
    ticks: Date[];
  }): Promise<{ checkinId: string; created: Date[] }> {
    return this.db.transaction(async (tx) => {
      const checkinId = uuidv7();

      await tx.insert(operatorCheckins).values({
        id: checkinId,
        operatorId: input.operatorId,
        locationId: input.locationId,
        availableFrom: input.availableFrom,
        availableUntil: input.availableUntil,
        checkedInGeog: makePoint(input.lng, input.lat) as never,
      });

      const inserted = await tx
        .insert(operatorSlots)
        .values(
          input.ticks.map((startAt) => ({
            id: uuidv7(),
            operatorId: input.operatorId,
            locationId: input.locationId,
            checkinId,
            startAt,
          })),
        )
        // The inference predicate must match the partial index exactly, or
        // Postgres cannot tell which unique index this conflict refers to.
        .onConflictDoNothing({
          target: [operatorSlots.operatorId, operatorSlots.startAt],
          where: sql`status <> 'cancelled'`,
        })
        .returning({ startAt: operatorSlots.startAt });

      const created = inserted.map((r) => r.startAt);
      const createdMs = new Set(created.map((d) => d.getTime()));
      const conflicts = input.ticks.filter((t) => !createdMs.has(t.getTime()));

      if (conflicts.length > 0) {
        // Aborts the transaction while carrying the colliding ticks out to the
        // service, which turns them into a 409 with the exact times.
        throw new CheckinConflict(conflicts);
      }

      await tx
        .update(operators)
        .set({ presence: 'online', updatedAt: new Date() })
        .where(eq(operators.id, input.operatorId));

      return { checkinId, created };
    });
  }

  findActiveCheckins(operatorId: string) {
    return this.db
      .select()
      .from(operatorCheckins)
      .where(
        and(eq(operatorCheckins.operatorId, operatorId), eq(operatorCheckins.status, 'active')),
      );
  }

  /**
   * Cancels only this check-in's OPEN slots. Booked slots survive: going
   * offline does not dissolve a commitment to a customer who already booked.
   *
   * Returns null when no such check-in belongs to that operator, which the
   * service turns into a 404 — the operator id is part of the WHERE, so this
   * doubles as the ownership check.
   */
  async endCheckin(operatorId: string, checkinId: string): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      const [checkin] = await tx
        .select({ id: operatorCheckins.id })
        .from(operatorCheckins)
        .where(
          and(eq(operatorCheckins.id, checkinId), eq(operatorCheckins.operatorId, operatorId)),
        );
      if (!checkin) return null;

      const cancelled = await tx
        .update(operatorSlots)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(operatorSlots.checkinId, checkinId), eq(operatorSlots.status, 'open')))
        .returning({ id: operatorSlots.id });

      await tx
        .update(operatorCheckins)
        .set({ status: 'ended', endedAt: new Date() })
        .where(eq(operatorCheckins.id, checkinId));

      await tx
        .update(operators)
        .set({ presence: 'offline', updatedAt: new Date() })
        .where(eq(operators.id, operatorId));

      return cancelled.length;
    });
  }

  bookedSlotsInRange(operatorId: string, from: Date, to: Date) {
    return this.db
      .select({ startAt: operatorSlots.startAt })
      .from(operatorSlots)
      .where(
        and(
          eq(operatorSlots.operatorId, operatorId),
          eq(operatorSlots.status, 'booked'),
          gte(operatorSlots.startAt, from),
          lt(operatorSlots.startAt, to),
        ),
      )
      .orderBy(asc(operatorSlots.startAt));
  }

  async cancelOpenSlotsInRange(operatorId: string, from: Date, to: Date): Promise<number> {
    const rows = await this.db
      .update(operatorSlots)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(operatorSlots.operatorId, operatorId),
          eq(operatorSlots.status, 'open'),
          gte(operatorSlots.startAt, from),
          lt(operatorSlots.startAt, to),
        ),
      )
      .returning({ id: operatorSlots.id });
    return rows.length;
  }

  /** Every status, not just open: the operator needs to see the whole day. */
  scheduleFor(operatorId: string, dayStart: Date, dayEnd: Date) {
    return this.db
      .select({
        id: operatorSlots.id,
        operatorId: operatorSlots.operatorId,
        locationId: operatorSlots.locationId,
        startAt: operatorSlots.startAt,
        status: operatorSlots.status,
      })
      .from(operatorSlots)
      .where(
        and(
          eq(operatorSlots.operatorId, operatorId),
          gte(operatorSlots.startAt, dayStart),
          lt(operatorSlots.startAt, dayEnd),
        ),
      )
      .orderBy(asc(operatorSlots.startAt));
  }
}

/** Internal signal: aborts the transaction while carrying the colliding ticks. */
export class CheckinConflict extends Error {
  constructor(readonly conflicts: Date[]) {
    super('checkin tick conflict');
    this.name = 'CheckinConflict';
  }
}
