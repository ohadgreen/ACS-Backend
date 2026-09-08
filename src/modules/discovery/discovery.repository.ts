import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { operatorSlots } from '../../infra/db/schema';
import { makePoint } from '../../infra/db/types';
import type { LocalizedText } from '../../common/localized/localized-text';

/**
 * A `type` rather than an `interface`: drizzle's `execute<T>` constrains T to
 * Record<string, unknown>, and only object *type aliases* get the implicit
 * index signature that satisfies it.
 */
export type NearbyLocationRow = {
  id: string;
  code: string;
  site_code: string;
  site_name: LocalizedText;
  name: LocalizedText;
  description: LocalizedText | null;
  distance_m: number;
  min_price: string | null;
  currency: string | null;
};

export interface CapacityRow {
  locationId: string;
  startAt: Date;
  capacity: number;
}

@Injectable()
export class DiscoveryRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The single most important query in the product. ST_DWithin on a GIST-indexed
   * geography column; the minimum price is a correlated subquery rather than a
   * join so a location with no active session types still appears with null.
   */
  async nearbyLocations(lat: number, lng: number, radiusM: number): Promise<NearbyLocationRow[]> {
    const point = makePoint(lng, lat);
    const res = await this.db.execute<NearbyLocationRow>(sql`
      SELECT
        l.id, l.code, l.site_code, l.site_name, l.name, l.description,
        ST_Distance(l.geog, ${point}) AS distance_m,
        (SELECT min(t.price)::text FROM location_session_types t
          WHERE t.location_id = l.id AND t.is_active) AS min_price,
        (SELECT t.currency FROM location_session_types t
          WHERE t.location_id = l.id AND t.is_active
          ORDER BY t.price ASC LIMIT 1) AS currency
      FROM locations l
      WHERE l.is_active AND ST_DWithin(l.geog, ${point}, ${radiusM})
      ORDER BY distance_m ASC
    `);
    return res.rows;
  }

  /**
   * Capacity is a count of open rows — never a stored number, and never a read
   * of operators.presence.
   */
  async slotCapacities(locationIds: string[], from: Date, to: Date): Promise<CapacityRow[]> {
    if (locationIds.length === 0) return [];
    const rows = await this.db
      .select({
        locationId: operatorSlots.locationId,
        startAt: operatorSlots.startAt,
        capacity: count(),
      })
      .from(operatorSlots)
      .where(
        and(
          inArray(operatorSlots.locationId, locationIds),
          eq(operatorSlots.status, 'open'),
          gte(operatorSlots.startAt, from),
          lt(operatorSlots.startAt, to),
        ),
      )
      .groupBy(operatorSlots.locationId, operatorSlots.startAt)
      .orderBy(asc(operatorSlots.startAt));

    return rows.map((r) => ({ ...r, capacity: Number(r.capacity) }));
  }
}
