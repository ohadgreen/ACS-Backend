import { customType } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';

/**
 * PostGIS geography. Reading this column back yields EWKB hex, which is useless
 * to the application, so every read that needs coordinates selects ST_X/ST_Y
 * explicitly. The column exists here so drizzle-kit emits the right DDL and so
 * ST_DWithin has a typed reference to point at.
 */
export const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType: () => 'geography(Point,4326)',
});

/** Longitude first — PostGIS point order is (x, y) = (lng, lat), not (lat, lng). */
export function makePoint(lng: number, lat: number): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
}
