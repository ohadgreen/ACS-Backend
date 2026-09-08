import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import {
  locations,
  locationSessionTypes,
  type LocationSessionType,
} from '../../infra/db/schema';
import { makePoint } from '../../infra/db/types';
import type { LocalizedText } from '../../common/localized/localized-text';

/** Geography never round-trips usefully, so reads project lat/lng explicitly. */
export interface LocationView {
  id: string;
  code: string;
  siteCode: string;
  siteName: LocalizedText;
  name: LocalizedText;
  description: LocalizedText | null;
  lat: number;
  lng: number;
  isActive: boolean;
}

const LOCATION_COLUMNS = {
  id: locations.id,
  code: locations.code,
  siteCode: locations.siteCode,
  siteName: locations.siteName,
  name: locations.name,
  description: locations.description,
  lat: sql<number>`ST_Y(${locations.geog}::geometry)`.as('lat'),
  lng: sql<number>`ST_X(${locations.geog}::geometry)`.as('lng'),
  isActive: locations.isActive,
};

@Injectable()
export class LocationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(input: {
    code: string;
    siteCode: string;
    siteName: LocalizedText;
    name: LocalizedText;
    description?: LocalizedText;
    lat: number;
    lng: number;
  }): Promise<LocationView> {
    const id = uuidv7();
    await this.db.insert(locations).values({
      id,
      code: input.code,
      siteCode: input.siteCode,
      siteName: input.siteName,
      name: input.name,
      description: input.description ?? null,
      geog: makePoint(input.lng, input.lat) as never,
    });
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<LocationView | undefined> {
    const [row] = await this.db
      .select(LOCATION_COLUMNS)
      .from(locations)
      .where(eq(locations.id, id));
    // ST_Y/ST_X come back as strings from node-postgres, so coerce here rather
    // than leaving every caller to remember it.
    return row ? { ...row, lat: Number(row.lat), lng: Number(row.lng) } : undefined;
  }

  async update(
    id: string,
    patch: Partial<{
      siteCode: string;
      siteName: LocalizedText;
      name: LocalizedText;
      description: LocalizedText;
      lat: number;
      lng: number;
      isActive: boolean;
    }>,
  ): Promise<LocationView | undefined> {
    const { lat, lng, ...rest } = patch;
    const values: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    // Both or neither: a half-moved point would silently land in the sea.
    if (lat !== undefined && lng !== undefined) values.geog = makePoint(lng, lat);

    const updated = await this.db
      .update(locations)
      .set(values as never)
      .where(eq(locations.id, id))
      .returning({ id: locations.id });
    if (updated.length === 0) return undefined;

    return this.findById(id);
  }

  async addSessionType(
    locationId: string,
    input: {
      code: string;
      name: LocalizedText;
      description?: LocalizedText;
      price: string;
      currency: string;
      sortOrder: number;
    },
  ): Promise<LocationSessionType> {
    const [row] = await this.db
      .insert(locationSessionTypes)
      .values({
        id: uuidv7(),
        locationId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        price: input.price,
        currency: input.currency,
        sortOrder: input.sortOrder,
      })
      .returning();
    return row!;
  }

  async findSessionType(id: string): Promise<LocationSessionType | undefined> {
    const [row] = await this.db
      .select()
      .from(locationSessionTypes)
      .where(eq(locationSessionTypes.id, id));
    return row;
  }

  async updateSessionType(
    id: string,
    patch: Partial<{
      name: LocalizedText;
      description: LocalizedText;
      price: string;
      isActive: boolean;
      sortOrder: number;
    }>,
  ): Promise<LocationSessionType | undefined> {
    const [row] = await this.db
      .update(locationSessionTypes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(locationSessionTypes.id, id))
      .returning();
    return row;
  }

  /**
   * Ordered by sortOrder then code: sortOrder is the admin's intent, and code
   * breaks ties so two types sharing an order never swap places between calls.
   */
  listActiveSessionTypes(locationId: string): Promise<LocationSessionType[]> {
    return this.db
      .select()
      .from(locationSessionTypes)
      .where(
        and(
          eq(locationSessionTypes.locationId, locationId),
          eq(locationSessionTypes.isActive, true),
        ),
      )
      .orderBy(asc(locationSessionTypes.sortOrder), asc(locationSessionTypes.code));
  }
}
