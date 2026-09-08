# ACS Backend Phase 2 — Core Booking Loop Implementation Plan

> **IMPLEMENTED — 2026-09-08.** Tasks 16–26 are all in `main`'s history. This
> file is kept as the record of what was followed, not as documentation: read
> `AGENTS.md` and the code for how the system works now.
>
> Every deviation from this plan is recorded in the commit that made it, with
> the reason. The substantive ones, for anyone reading the plan on its own:
>
> - **Task 24's fairness query needs `FOR UPDATE OF s SKIP LOCKED`.** Postgres
>   refuses row locking on the nullable side of an outer join, so the plain
>   `FOR UPDATE SKIP LOCKED` written below is rejected outright once the
>   `LEFT JOIN LATERAL` is present — no booking would ever have succeeded.
> - **`bookings.operator_slot_id` carries a partial unique index over the
>   active statuses, not a plain `.unique()` column.** A total constraint
>   contradicts the cancellation policy in Task 25: releasing a slot back to
>   `open` for resale would leave it permanently unsellable.
> - **Task 22's `todayAt(hour)` fixtures could not have passed.** Discovery
>   serves `[now + BOOKING_LEAD_TIME_MIN, end of today)`, and 21:00Z — used for
>   the capacity assertion — is exactly the *end* of the Asia/Jerusalem business
>   day in summer. Fixtures now derive their tick from the clock.
> - **`z.coerce.date()` cannot be used in a DTO.** It has no JSON Schema
>   representation and zod throws while the OpenAPI document is built, killing
>   the process at boot rather than at first request. The date fields parse with
>   `z.iso.datetime({ offset: true }).transform(...)` instead.
> - **Non-creating POST routes need `@HttpCode(200)`.** Nest answers POST with
>   201 by default, which several of the plan's own assertions contradicted.
> - **Schema tests assert constraint names off the error cause chain.** Drizzle
>   wraps driver errors, so `rejects.toThrow(/grid_aligned/)` never matches the
>   message and would pass on any failure at all.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the technical heart of the product — admin-curated locations with per-location session types, operator check-in materializing a fixed 15-minute slot grid, geo discovery, and booking with atomic fair operator assignment plus a pure-domain lifecycle state machine.

**Architecture:** Inventory is materialized into `operator_slots` rows rather than counted, so a single `FOR UPDATE SKIP LOCKED` statement both selects a slot and assigns the least-loaded operator. The booking state machine is pure TypeScript with no Nest, no database, and no clock of its own, making every transition and every *forbidden* transition an exhaustive unit test.

**Tech Stack:** Same as Phase 1 — NestJS 11 · Drizzle · Postgres 16 + PostGIS 3.4 · Redis 7 · zod · Vitest — plus `luxon` for timezone-aware business-day boundaries.

**Spec:** `docs/superpowers/specs/2026-09-02-acs-backend-foundation-booking-design.md`

**Prerequisite:** `completed/2026-09-06-acs-backend-phase1-foundation-auth.md` must be complete, with its completion checklist satisfied. Task numbering continues from Phase 1 (which ended at Task 15).

## Global Constraints

Everything in the Phase 1 Global Constraints section still applies. Additionally:

- **All sessions are 15 minutes.** `SLOT_DURATION_MIN` (default 15) is the grid tick. Session type varies price and style, never duration.
- **The slot grid is global and fixed** at `:00 :15 :30 :45` with zero seconds, verified by a database CHECK using `AT TIME ZONE 'UTC'` so the expression stays immutable.
- **Capacity is the count of checked-in operators**, expressed as the existence of `operator_slots` rows — never as a number in a column.
- **Fairness rule:** the assigned operator is the one with the fewest bookings **assigned for today, including upcoming ones**, `random()` on ties. Counting only completed sessions would route every advance booking to the same operator.
- **`operators.presence` is never consulted for availability.** Discovery reads slot rows only. Presence is display state, maintained by check-in and by booking transitions.
- **Localized display strings are `LocalizedText`** — a `jsonb` object keyed by locale, CHECK-enforced to carry every supported locale. Responses return every locale, never a pre-resolved string.
- **Identity is separate from display:** `locations.code`, `locations.site_code`, and `location_session_types.code` are stable slugs, never localized, and own uniqueness and grouping.
- **`price_snapshot` and `currency` are copied onto the booking at creation.** Editing a price must never retroactively change what a booked customer owes.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/infra/db/types.ts` | `geographyPoint` custom column type + `LocalizedText` type |
| `src/infra/db/schema/locations.ts` | `locations`, `location_session_types` |
| `src/infra/db/schema/slots.ts` | `operator_checkins`, `operator_slots` |
| `src/infra/db/schema/bookings.ts` | `bookings` |
| `src/common/time/grid.ts` | Pure grid alignment and tick enumeration |
| `src/common/time/business-day.ts` | Timezone-aware day boundaries — the only place "today" exists |
| `src/common/localized/localized-text.ts` | zod schema factory validating against `SUPPORTED_LOCALES` |
| `src/modules/locations/` | Admin CRUD for locations and session types |
| `src/modules/presence/` | Check-in, check-out, breaks, schedule, slot materialization |
| `src/modules/discovery/` | The geo query and its two read endpoints |
| `src/modules/bookings/domain/state-machine.ts` | Pure transition function — no I/O |
| `src/modules/bookings/bookings.repository.ts` | The fairness query and all booking persistence |
| `src/modules/bookings/booking-access.guard.ts` | Per-resource ownership check |
| `src/modules/maintenance/` | Expiry sweep, admin-triggerable |

---

## Task 16: Localized Text, Geography Types & Locations Schema

**Files:**
- Create: `src/infra/db/types.ts`, `src/common/localized/localized-text.ts`
- Create: `src/infra/db/schema/locations.ts`
- Modify: `src/infra/db/schema/index.ts`
- Create: `drizzle/0002_locations.sql`
- Test: `src/common/localized/localized-text.spec.ts`, `test/integration/schema-locations.spec.ts`

**Interfaces:**
- Consumes: `getTestDb` (Task 2), `Env` (Task 1).
- Produces: `LocalizedText = Record<string, string>`; `localizedTextSchema(locales: string[])` returning a zod schema; `geographyPoint` drizzle column type; `makePoint(lng, lat)` SQL helper; drizzle tables `locations`, `locationSessionTypes` with types `Location`, `LocationSessionType`.

- [ ] **Step 1: Install luxon**

```bash
pnpm add luxon
pnpm add -D @types/luxon
```

- [ ] **Step 2: Write the failing LocalizedText validation test**

Create `src/common/localized/localized-text.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { localizedTextSchema } from './localized-text';

const schema = localizedTextSchema(['en', 'he']);

describe('localizedTextSchema', () => {
  it('accepts an object carrying every supported locale', () => {
    expect(schema.parse({ en: 'Beginner Slope', he: 'מסלול מתחילים' })).toEqual({
      en: 'Beginner Slope',
      he: 'מסלול מתחילים',
    });
  });

  it('rejects a missing locale', () => {
    expect(() => schema.parse({ en: 'Beginner Slope' })).toThrow();
  });

  it('rejects an empty string for a supported locale', () => {
    expect(() => schema.parse({ en: '', he: 'מסלול' })).toThrow();
  });

  it('rejects an unsupported extra locale rather than silently keeping it', () => {
    expect(() => schema.parse({ en: 'A', he: 'ב', fr: 'C' })).toThrow();
  });

  it('rejects a plain string', () => {
    expect(() => schema.parse('Beginner Slope')).toThrow();
  });

  it('adapts to a different supported set', () => {
    const trilingual = localizedTextSchema(['en', 'he', 'ar']);
    expect(() => trilingual.parse({ en: 'A', he: 'ב' })).toThrow();
    expect(trilingual.parse({ en: 'A', he: 'ב', ar: 'ج' })).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify it fails, then implement**

Run: `pnpm test:unit` → FAIL

`src/common/localized/localized-text.ts`:
```ts
import { z } from 'zod';

export type LocalizedText = Record<string, string>;

/**
 * Builds a strict validator for the configured locale set. Strict rather than
 * permissive: an unexpected locale key is a typo or a config drift, and letting
 * it through means it silently never renders anywhere.
 */
export function localizedTextSchema(locales: string[]) {
  const shape = Object.fromEntries(
    locales.map((locale) => [locale, z.string().min(1).max(2000)]),
  );
  return z.object(shape).strict();
}

export const SUPPORTED_LOCALES_TOKEN = Symbol('SUPPORTED_LOCALES');
```

- [ ] **Step 4: Implement the geography column type**

`src/infra/db/types.ts`:
```ts
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
```

- [ ] **Step 5: Write the failing locations schema test**

Create `test/integration/schema-locations.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from './db.helper';
import { locations, locationSessionTypes } from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';

const db = () => getTestDb();

async function insertLocation(overrides: Partial<{ code: string; name: unknown }> = {}) {
  const id = uuidv7();
  await db()
    .insert(locations)
    .values({
      id,
      code: overrides.code ?? `loc-${id.slice(0, 8)}`,
      siteCode: 'hermon',
      siteName: { en: 'Hermon Resort', he: 'אתר החרמון' },
      name: (overrides.name ?? { en: 'Beginner Slope', he: 'מסלול מתחילים' }) as never,
      geog: sql`${makePoint(35.7896, 33.3053)}` as never,
    });
  return id;
}

describe('locations schema', () => {
  it('stores a location with localized names and a geography point', async () => {
    const id = await insertLocation();
    const res = await db().execute<{ lat: number; lng: number }>(sql`
      SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng
      FROM locations WHERE id = ${id}
    `);
    expect(Number(res.rows[0]?.lat)).toBeCloseTo(33.3053, 4);
    expect(Number(res.rows[0]?.lng)).toBeCloseTo(35.7896, 4);
  });

  it('rejects a name missing a required locale', async () => {
    await expect(insertLocation({ name: { en: 'Only English' } })).rejects.toThrow();
  });

  it('enforces global code uniqueness', async () => {
    await insertLocation({ code: 'duplicate-code' });
    await expect(insertLocation({ code: 'duplicate-code' })).rejects.toThrow();
  });

  it('finds locations by radius using ST_DWithin', async () => {
    await insertLocation({ code: 'near' });
    const near = await db().execute<{ id: string }>(sql`
      SELECT id FROM locations
      WHERE ST_DWithin(geog, ${makePoint(35.7897, 33.3054)}, 300)
    `);
    const far = await db().execute<{ id: string }>(sql`
      SELECT id FROM locations
      WHERE ST_DWithin(geog, ${makePoint(34.7818, 32.0853)}, 300)
    `);
    expect(near.rows.length).toBeGreaterThan(0);
    expect(far.rows).toHaveLength(0);
  });

  it('scopes session type codes to their location', async () => {
    const a = await insertLocation({ code: 'loc-a' });
    const b = await insertLocation({ code: 'loc-b' });

    const make = (locationId: string) =>
      db().insert(locationSessionTypes).values({
        id: uuidv7(),
        locationId,
        code: 'extreme',
        name: { en: 'Extreme', he: 'אקסטרים' },
        price: '250.00',
      });

    await make(a);
    // The same code at a different location is a different offering entirely.
    await expect(make(b)).resolves.toBeDefined();
    // The same code at the same location is a duplicate.
    await expect(make(a)).rejects.toThrow();
  });

  it('rejects a negative price', async () => {
    const id = await insertLocation({ code: 'price-check' });
    await expect(
      db().insert(locationSessionTypes).values({
        id: uuidv7(),
        locationId: id,
        code: 'bad',
        name: { en: 'Bad', he: 'רע' },
        price: '-1.00',
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run to verify it fails, then implement the schema**

Run: `pnpm test:integration` → FAIL

`src/infra/db/schema/locations.ts`:
```ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { geographyPoint } from '../types';
import type { LocalizedText } from '../../../common/localized/localized-text';

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull().unique(),
    siteCode: text('site_code').notNull(),
    siteName: jsonb('site_name').$type<LocalizedText>().notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    description: jsonb('description').$type<LocalizedText>(),
    geog: geographyPoint('geog').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('locations_site_idx').on(t.siteCode),
    // jsonb_exists(), never the `?` operator — node-postgres reads `?` as a
    // parameter placeholder and the operator form fails at runtime.
    check(
      'locations_site_name_locales',
      sql`jsonb_exists(${t.siteName}, 'en') AND jsonb_exists(${t.siteName}, 'he')`,
    ),
    check(
      'locations_name_locales',
      sql`jsonb_exists(${t.name}, 'en') AND jsonb_exists(${t.name}, 'he')`,
    ),
  ],
);

export const locationSessionTypes = pgTable(
  'location_session_types',
  {
    id: uuid('id').primaryKey(),
    locationId: uuid('location_id').notNull().references(() => locations.id),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    description: jsonb('description').$type<LocalizedText>(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('ILS'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('location_session_types_location_code').on(t.locationId, t.code),
    check('location_session_types_price_nonneg', sql`${t.price} >= 0`),
    check(
      'location_session_types_name_locales',
      sql`jsonb_exists(${t.name}, 'en') AND jsonb_exists(${t.name}, 'he')`,
    ),
  ],
);

export type Location = typeof locations.$inferSelect;
export type LocationSessionType = typeof locationSessionTypes.$inferSelect;
```

Add `export * from './locations';` to `src/infra/db/schema/index.ts`.

- [ ] **Step 7: Generate the migration and add the GIST index by hand**

```bash
pnpm drizzle-kit generate --name locations
```

drizzle-kit does not emit GIST indexes for custom column types. Append to the generated `drizzle/0002_locations.sql`:

```sql
CREATE INDEX IF NOT EXISTS "locations_geog_idx" ON "locations" USING GIST ("geog");
```

Confirm the file also contains the three `jsonb_exists` CHECK constraints; add them by hand if drizzle-kit omitted them.

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm test:integration`
Expected: PASS — 6 tests

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat: localized text validation, geography column type, locations schema"
```

---

## Task 17: Admin Locations & Session Types CRUD

**Files:**
- Create: `src/modules/locations/locations.repository.ts`, `src/modules/locations/locations.service.ts`, `src/modules/locations/admin-locations.controller.ts`, `src/modules/locations/locations.module.ts`
- Create: `src/modules/locations/dto/location.dto.ts`, `src/modules/locations/dto/session-type.dto.ts`
- Modify: `src/app.module.ts`, `test/e2e/authz-matrix.spec.ts`
- Test: `test/e2e/admin-locations.spec.ts`

**Interfaces:**
- Consumes: `locations`/`locationSessionTypes` (16), `@Roles` (Task 7).
- Produces:
  - `LocationsRepository.create(input)`, `update(id, patch)`, `findById(id)`, `findByIdActive(id)`, `addSessionType(locationId, input)`, `updateSessionType(id, patch)`, `findSessionType(id)`, `listActiveSessionTypes(locationId)`
  - `POST /admin/locations`, `PATCH /admin/locations/:id`, `POST /admin/locations/:id/session-types`, `PATCH /admin/session-types/:id`

- [ ] **Step 1: Write the failing admin CRUD test**

Create `test/e2e/admin-locations.spec.ts`:
```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import { users } from '../../src/infra/db/schema';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';

let app: TestApp;
let adminAuth: string;

beforeAll(async () => {
  app = await createTestApp();
  const adminId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: adminId, role: 'admin', email: 'loc-admin@example.com', displayName: 'Admin' });
  adminAuth = `Bearer ${app.app
    .get(TokenService)
    .issueAccessToken({ sub: adminId, role: 'admin', jti: uuidv7() })}`;
});
afterAll(async () => {
  await app.close();
});

const validLocation = (code: string) => ({
  code,
  siteCode: 'hermon',
  siteName: { en: 'Hermon Resort', he: 'אתר החרמון' },
  name: { en: 'Beginner Slope', he: 'מסלול מתחילים' },
  description: { en: 'Gentle gradient.', he: 'שיפוע מתון.' },
  lat: 33.3053,
  lng: 35.7896,
});

describe('admin locations', () => {
  it('creates a location and echoes every locale', async () => {
    const res = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('beginner-slope'))
      .expect(201);

    expect(res.body.name).toEqual({ en: 'Beginner Slope', he: 'מסלול מתחילים' });
    expect(res.body.lat).toBeCloseTo(33.3053, 4);
    expect(res.body.lng).toBeCloseTo(35.7896, 4);
  });

  it('rejects a name missing Hebrew with 422', async () => {
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send({ ...validLocation('missing-he'), name: { en: 'English only' } })
      .expect(422);
  });

  it('rejects out-of-range coordinates with 422', async () => {
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send({ ...validLocation('bad-coords'), lat: 100, lng: 35 })
      .expect(422);
  });

  it('rejects a duplicate code with 409', async () => {
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('dup-code'))
      .expect(201);
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('dup-code'))
      .expect(409);
  });

  it('adds a session type with a price', async () => {
    const loc = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('with-types'))
      .expect(201);

    const res = await request(app.server)
      .post(`/admin/locations/${loc.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send({
        code: 'extreme',
        name: { en: 'Extreme', he: 'אקסטרים' },
        price: '250.00',
        currency: 'ILS',
      })
      .expect(201);

    expect(res.body).toMatchObject({ code: 'extreme', price: '250.00', currency: 'ILS' });
  });

  it('lets two locations reuse the same session-type code', async () => {
    const a = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('reuse-a'))
      .expect(201);
    const b = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('reuse-b'))
      .expect(201);

    const body = { code: 'mild', name: { en: 'Mild', he: 'רגוע' }, price: '100.00' };
    await request(app.server)
      .post(`/admin/locations/${a.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send(body)
      .expect(201);
    await request(app.server)
      .post(`/admin/locations/${b.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send(body)
      .expect(201);
  });

  it('deactivates a location without deleting it', async () => {
    const loc = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('deactivate-me'))
      .expect(201);

    const res = await request(app.server)
      .patch(`/admin/locations/${loc.body.id}`)
      .set('Authorization', adminAuth)
      .send({ isActive: false })
      .expect(200);

    expect(res.body.isActive).toBe(false);
  });

  it('rejects a non-admin with 403', async () => {
    const operator = `Bearer ${app.app.get(TokenService).issueAccessToken({
      sub: uuidv7(),
      role: 'operator',
      operatorId: uuidv7(),
      jti: uuidv7(),
    })}`;
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', operator)
      .send(validLocation('forbidden'))
      .expect(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — `/admin/locations` returns 404

- [ ] **Step 3: Implement the DTOs**

`src/modules/locations/dto/location.dto.ts`:
```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localizedTextSchema } from '../../../common/localized/localized-text';

const locales = (process.env.SUPPORTED_LOCALES ?? 'en,he').split(',').map((s) => s.trim());
const localized = localizedTextSchema(locales);

export const createLocationSchema = z.object({
  code: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/),
  siteCode: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/),
  siteName: localized,
  name: localized,
  description: localized.optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const updateLocationSchema = z
  .object({
    siteCode: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/).optional(),
    siteName: localized.optional(),
    name: localized.optional(),
    description: localized.optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    isActive: z.boolean().optional(),
  })
  .strip();

export class CreateLocationDto extends createZodDto(createLocationSchema) {}
export class UpdateLocationDto extends createZodDto(updateLocationSchema) {}
```

`src/modules/locations/dto/session-type.dto.ts`:
```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localizedTextSchema } from '../../../common/localized/localized-text';

const locales = (process.env.SUPPORTED_LOCALES ?? 'en,he').split(',').map((s) => s.trim());
const localized = localizedTextSchema(locales);

/** Money crosses the wire as a decimal string; never a float. */
const money = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/);

export const createSessionTypeSchema = z.object({
  code: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  name: localized,
  description: localized.optional(),
  price: money,
  currency: z.string().length(3).default('ILS'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const updateSessionTypeSchema = z
  .object({
    name: localized.optional(),
    description: localized.optional(),
    price: money.optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strip();

export class CreateSessionTypeDto extends createZodDto(createSessionTypeSchema) {}
export class UpdateSessionTypeDto extends createZodDto(updateSessionTypeSchema) {}
```

- [ ] **Step 4: Implement the repository**

`src/modules/locations/locations.repository.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { locations, locationSessionTypes, type LocationSessionType } from '../../infra/db/schema';
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
    const [row] = await this.db.select(LOCATION_COLUMNS).from(locations).where(eq(locations.id, id));
    return row as LocationView | undefined;
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
    if (lat !== undefined && lng !== undefined) values.geog = makePoint(lng, lat);

    await this.db.update(locations).set(values as never).where(eq(locations.id, id));
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
      .orderBy(asc(locationSessionTypes.sortOrder));
  }
}
```

- [ ] **Step 5: Implement the service and controller**

`src/modules/locations/locations.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { LocationsRepository } from './locations.repository';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';

@Injectable()
export class LocationsService {
  constructor(private readonly repo: LocationsRepository) {}

  async create(input: Parameters<LocationsRepository['create']>[0]) {
    try {
      return await this.repo.create(input);
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new ConflictError(ErrorCodes.VALIDATION_FAILED, 'That location code already exists.', {
          field: 'code',
        });
      }
      throw cause;
    }
  }

  async update(id: string, patch: Parameters<LocationsRepository['update']>[1]) {
    const updated = await this.repo.update(id, patch);
    if (!updated) throw new NotFoundError('LOCATION_NOT_FOUND', 'No such location.');
    return updated;
  }

  async requireActive(id: string) {
    const location = await this.repo.findById(id);
    if (!location || !location.isActive) {
      throw new NotFoundError('LOCATION_NOT_FOUND', 'No such active location.');
    }
    return location;
  }

  async addSessionType(
    locationId: string,
    input: Parameters<LocationsRepository['addSessionType']>[1],
  ) {
    await this.requireActive(locationId);
    try {
      return await this.repo.addSessionType(locationId, input);
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new ConflictError(
          ErrorCodes.VALIDATION_FAILED,
          'That session type code already exists at this location.',
          { field: 'code' },
        );
      }
      throw cause;
    }
  }

  async updateSessionType(
    id: string,
    patch: Parameters<LocationsRepository['updateSessionType']>[1],
  ) {
    const updated = await this.repo.updateSessionType(id, patch);
    if (!updated) throw new NotFoundError('SESSION_TYPE_NOT_FOUND', 'No such session type.');
    return updated;
  }
}

/** Postgres unique_violation. */
export function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505';
}
```

`src/modules/locations/admin-locations.controller.ts`:
```ts
import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { LocationsService } from './locations.service';
import { CreateLocationDto, UpdateLocationDto } from './dto/location.dto';
import { CreateSessionTypeDto, UpdateSessionTypeDto } from './dto/session-type.dto';

@Roles('admin')
@Controller('admin')
export class AdminLocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Post('locations')
  create(@Body() dto: CreateLocationDto) {
    return this.locations.create(dto);
  }

  @Patch('locations/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return this.locations.update(id, dto);
  }

  @Post('locations/:id/session-types')
  addSessionType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateSessionTypeDto) {
    return this.locations.addSessionType(id, dto);
  }

  @Patch('session-types/:id')
  updateSessionType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSessionTypeDto) {
    return this.locations.updateSessionType(id, dto);
  }
}
```

`src/modules/locations/locations.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AdminLocationsController } from './admin-locations.controller';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';

@Module({
  controllers: [AdminLocationsController],
  providers: [LocationsRepository, LocationsService],
  exports: [LocationsRepository, LocationsService],
})
export class LocationsModule {}
```

Add `LocationsModule` to `src/app.module.ts`, and add `LOCATION_NOT_FOUND` and `SESSION_TYPE_NOT_FOUND` to `src/common/errors/error-codes.ts`.

- [ ] **Step 6: Extend the authorization matrix**

Add to `PROTECTED_ROUTES` in `test/e2e/authz-matrix.spec.ts`:
```ts
  { method: 'post', path: '/admin/locations', allow: ['admin'], body: {} },
  { method: 'patch', path: `/admin/locations/${uuidv7()}`, allow: ['admin'], body: {} },
  { method: 'post', path: `/admin/locations/${uuidv7()}/session-types`, allow: ['admin'], body: {} },
  { method: 'patch', path: `/admin/session-types/${uuidv7()}`, allow: ['admin'], body: {} },
```

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm test:integration`
Expected: PASS — 8 new tests, matrix still green

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat: admin CRUD for locations and per-location session types"
```

---

## Task 18: Grid & Business-Day Utilities

**Files:**
- Create: `src/common/time/grid.ts`, `src/common/time/business-day.ts`
- Test: `src/common/time/grid.spec.ts`, `src/common/time/business-day.spec.ts`

**Interfaces:**
- Consumes: `luxon`.
- Produces:
  - `isGridAligned(at: Date, slotMinutes: number): boolean`
  - `gridTicks(from: Date, to: Date, slotMinutes: number): Date[]` — half-open `[from, to)`
  - `businessDayBounds(instant: Date, timeZone: string): { start: Date; end: Date }`
  - `isSameBusinessDay(a: Date, b: Date, timeZone: string): boolean`

- [ ] **Step 1: Write the failing grid test**

Create `src/common/time/grid.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { gridTicks, isGridAligned } from './grid';

const at = (iso: string) => new Date(iso);

describe('isGridAligned', () => {
  it.each(['2026-09-06T10:00:00.000Z', '2026-09-06T10:15:00.000Z', '2026-09-06T10:30:00.000Z', '2026-09-06T10:45:00.000Z'])(
    'accepts %s',
    (iso) => {
      expect(isGridAligned(at(iso), 15)).toBe(true);
    },
  );

  it.each(['2026-09-06T10:07:00.000Z', '2026-09-06T10:15:30.000Z', '2026-09-06T10:15:00.500Z'])(
    'rejects %s',
    (iso) => {
      expect(isGridAligned(at(iso), 15)).toBe(false);
    },
  );

  it('honours a different tick size', () => {
    expect(isGridAligned(at('2026-09-06T10:10:00.000Z'), 10)).toBe(true);
    expect(isGridAligned(at('2026-09-06T10:10:00.000Z'), 15)).toBe(false);
  });
});

describe('gridTicks', () => {
  it('enumerates a half-open range — the end is excluded', () => {
    const ticks = gridTicks(at('2026-09-06T10:00:00.000Z'), at('2026-09-06T11:00:00.000Z'), 15);
    expect(ticks.map((t) => t.toISOString())).toEqual([
      '2026-09-06T10:00:00.000Z',
      '2026-09-06T10:15:00.000Z',
      '2026-09-06T10:30:00.000Z',
      '2026-09-06T10:45:00.000Z',
    ]);
  });

  it('returns one tick for a single-slot window', () => {
    expect(gridTicks(at('2026-09-06T10:00:00.000Z'), at('2026-09-06T10:15:00.000Z'), 15)).toHaveLength(1);
  });

  it('returns nothing when the range is empty or inverted', () => {
    expect(gridTicks(at('2026-09-06T10:00:00.000Z'), at('2026-09-06T10:00:00.000Z'), 15)).toEqual([]);
    expect(gridTicks(at('2026-09-06T11:00:00.000Z'), at('2026-09-06T10:00:00.000Z'), 15)).toEqual([]);
  });

  it('throws when either bound is off-grid', () => {
    expect(() => gridTicks(at('2026-09-06T10:07:00.000Z'), at('2026-09-06T11:00:00.000Z'), 15)).toThrow();
    expect(() => gridTicks(at('2026-09-06T10:00:00.000Z'), at('2026-09-06T11:07:00.000Z'), 15)).toThrow();
  });
});
```

- [ ] **Step 2: Write the failing business-day test**

Create `src/common/time/business-day.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { businessDayBounds, isSameBusinessDay } from './business-day';

const TZ = 'Asia/Jerusalem';

describe('businessDayBounds', () => {
  it('spans exactly 24 hours on an ordinary day', () => {
    const { start, end } = businessDayBounds(new Date('2026-09-06T12:00:00.000Z'), TZ);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('starts at local midnight, not UTC midnight', () => {
    // Israel is UTC+3 in September, so local midnight is 21:00 UTC the day before.
    const { start } = businessDayBounds(new Date('2026-09-06T12:00:00.000Z'), TZ);
    expect(start.toISOString()).toBe('2026-09-05T21:00:00.000Z');
  });

  it('assigns a late-evening UTC instant to the following local day', () => {
    // 22:00 UTC on the 5th is 01:00 local on the 6th.
    const { start } = businessDayBounds(new Date('2026-09-05T22:00:00.000Z'), TZ);
    expect(start.toISOString()).toBe('2026-09-05T21:00:00.000Z');
  });

  it('handles a DST transition without producing a 24-hour assumption', () => {
    // Israel ends DST in late October; the day is 25 hours long.
    const { start, end } = businessDayBounds(new Date('2026-10-25T12:00:00.000Z'), TZ);
    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    expect([23, 24, 25]).toContain(hours);
  });
});

describe('isSameBusinessDay', () => {
  it('groups two instants inside one local day', () => {
    expect(
      isSameBusinessDay(
        new Date('2026-09-06T06:00:00.000Z'),
        new Date('2026-09-06T18:00:00.000Z'),
        TZ,
      ),
    ).toBe(true);
  });

  it('separates instants across local midnight even when UTC dates match', () => {
    // Both are 2026-09-05 in UTC, but 21:30 UTC is already the 6th locally.
    expect(
      isSameBusinessDay(
        new Date('2026-09-05T18:00:00.000Z'),
        new Date('2026-09-05T21:30:00.000Z'),
        TZ,
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `pnpm test:unit`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement the utilities**

`src/common/time/grid.ts`:
```ts
import { ValidationError } from '../errors/domain-error';
import { ErrorCodes } from '../errors/error-codes';

const MINUTE_MS = 60_000;

/**
 * The grid is anchored to the UTC epoch, which makes alignment a pure modulo
 * check and independent of any timezone. For every tick size that divides an
 * hour, this agrees with "minutes are :00/:15/:30/:45" in any real zone.
 */
export function isGridAligned(at: Date, slotMinutes: number): boolean {
  return at.getTime() % (slotMinutes * MINUTE_MS) === 0;
}

/** Enumerates the half-open range [from, to). Both bounds must be aligned. */
export function gridTicks(from: Date, to: Date, slotMinutes: number): Date[] {
  if (!isGridAligned(from, slotMinutes)) {
    throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Start is not aligned to the slot grid.', {
      field: 'from',
      slotMinutes,
    });
  }
  if (!isGridAligned(to, slotMinutes)) {
    throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'End is not aligned to the slot grid.', {
      field: 'to',
      slotMinutes,
    });
  }

  const step = slotMinutes * MINUTE_MS;
  const ticks: Date[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += step) {
    ticks.push(new Date(t));
  }
  return ticks;
}
```

`src/common/time/business-day.ts`:
```ts
import { DateTime } from 'luxon';

/**
 * The only place "today" is computed. Every caller passes the configured
 * BUSINESS_TIMEZONE; nothing anywhere else may use a local Date to decide
 * which day an instant belongs to, or midnight becomes an off-by-one.
 */
export function businessDayBounds(instant: Date, timeZone: string): { start: Date; end: Date } {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  const start = local.startOf('day');
  // plus({ days: 1 }) rather than plus({ hours: 24 }) so DST transitions produce
  // a correct 23- or 25-hour day instead of a silently wrong boundary.
  return { start: start.toUTC().toJSDate(), end: start.plus({ days: 1 }).toUTC().toJSDate() };
}

export function isSameBusinessDay(a: Date, b: Date, timeZone: string): boolean {
  return (
    businessDayBounds(a, timeZone).start.getTime() === businessDayBounds(b, timeZone).start.getTime()
  );
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm test:unit`
Expected: PASS — 15 new tests

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: pure grid alignment and timezone-aware business-day utilities"
```

---

## Task 19: Check-in & Slot Inventory Schema

**Files:**
- Create: `src/infra/db/schema/slots.ts`
- Modify: `src/infra/db/schema/index.ts`
- Create: `drizzle/0003_slots.sql`
- Test: `test/integration/schema-slots.spec.ts`

**Interfaces:**
- Consumes: `operators` (Task 4), `locations` (Task 16).
- Produces: drizzle tables `operatorCheckins`, `operatorSlots`; enums `checkinStatus`, `slotStatus`; types `OperatorCheckin`, `OperatorSlot`.

- [ ] **Step 1: Write the failing schema test**

Create `test/integration/schema-slots.spec.ts`:
```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from './db.helper';
import {
  locations,
  operatorCheckins,
  operatorSlots,
  operators,
  users,
} from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';

const db = () => getTestDb();
let operatorA: string;
let operatorB: string;
let locationId: string;
let checkinId: string;

async function makeOperator(email: string) {
  const userId = uuidv7();
  const operatorId = uuidv7();
  await db().insert(users).values({ id: userId, role: 'operator', email, displayName: 'P' });
  await db()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });
  return operatorId;
}

beforeEach(async () => {
  operatorA = await makeOperator(`a-${uuidv7()}@example.com`);
  operatorB = await makeOperator(`b-${uuidv7()}@example.com`);

  locationId = uuidv7();
  await db().insert(locations).values({
    id: locationId,
    code: `loc-${locationId.slice(0, 8)}`,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    geog: makePoint(35.7896, 33.3053) as never,
  });

  checkinId = uuidv7();
  await db().insert(operatorCheckins).values({
    id: checkinId,
    operatorId: operatorA,
    locationId,
    availableFrom: new Date('2026-09-06T07:00:00.000Z'),
    availableUntil: new Date('2026-09-06T11:00:00.000Z'),
    checkedInGeog: makePoint(35.7896, 33.3053) as never,
  });
});

const slot = (operatorId: string, iso: string, status: 'open' | 'booked' | 'cancelled' = 'open') => ({
  id: uuidv7(),
  operatorId,
  locationId,
  checkinId,
  startAt: new Date(iso),
  status,
});

describe('slot inventory schema', () => {
  it('accepts a grid-aligned slot', async () => {
    await expect(
      db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z')),
    ).resolves.toBeDefined();
  });

  it('rejects an off-grid start time', async () => {
    await expect(
      db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:07:00.000Z')),
    ).rejects.toThrow(/grid_aligned/);
  });

  it('rejects a start time with non-zero seconds', async () => {
    await expect(
      db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:15:30.000Z')),
    ).rejects.toThrow(/grid_aligned/);
  });

  it('forbids one operator holding two slots at the same tick', async () => {
    await db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z'));
    await expect(
      db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z')),
    ).rejects.toThrow();
  });

  it('allows two different operators at the same tick — that is capacity 2', async () => {
    await db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z'));
    await expect(
      db().insert(operatorSlots).values(slot(operatorB, '2026-09-06T08:00:00.000Z')),
    ).resolves.toBeDefined();
  });

  it('permits regenerating a tick that was cancelled — the index is partial', async () => {
    await db()
      .insert(operatorSlots)
      .values(slot(operatorA, '2026-09-06T08:00:00.000Z', 'cancelled'));
    // Without WHERE status <> 'cancelled', a check-out would poison this tick
    // permanently and the operator could never check in for it again.
    await expect(
      db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z')),
    ).resolves.toBeDefined();
  });

  it('requires the check-in window to be non-empty', async () => {
    await expect(
      db().insert(operatorCheckins).values({
        id: uuidv7(),
        operatorId: operatorB,
        locationId,
        availableFrom: new Date('2026-09-06T11:00:00.000Z'),
        availableUntil: new Date('2026-09-06T11:00:00.000Z'),
        checkedInGeog: makePoint(35.7896, 33.3053) as never,
      }),
    ).rejects.toThrow();
  });

  it('retains the reported check-in position for audit', async () => {
    const res = await db().execute<{ lat: number }>(sql`
      SELECT ST_Y(checked_in_geog::geometry) AS lat FROM operator_checkins WHERE id = ${checkinId}
    `);
    expect(Number(res.rows[0]?.lat)).toBeCloseTo(33.3053, 4);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement the schema**

Run: `pnpm test:integration` → FAIL

`src/infra/db/schema/slots.ts`:
```ts
import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { geographyPoint } from '../types';
import { locations } from './locations';
import { operators } from './operators';

export const checkinStatus = pgEnum('checkin_status', ['active', 'ended']);
export const slotStatus = pgEnum('slot_status', ['open', 'booked', 'cancelled', 'expired']);

export const operatorCheckins = pgTable(
  'operator_checkins',
  {
    id: uuid('id').primaryKey(),
    operatorId: uuid('operator_id').notNull().references(() => operators.id),
    locationId: uuid('location_id').notNull().references(() => locations.id),
    availableFrom: timestamp('available_from', { withTimezone: true }).notNull(),
    availableUntil: timestamp('available_until', { withTimezone: true }).notNull(),
    checkedInGeog: geographyPoint('checked_in_geog').notNull(),
    status: checkinStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('operator_checkins_operator_idx').on(t.operatorId, t.status),
    index('operator_checkins_location_idx').on(t.locationId, t.availableFrom),
    check('operator_checkins_window', sql`${t.availableUntil} > ${t.availableFrom}`),
  ],
);

export const operatorSlots = pgTable(
  'operator_slots',
  {
    id: uuid('id').primaryKey(),
    operatorId: uuid('operator_id').notNull().references(() => operators.id),
    locationId: uuid('location_id').notNull().references(() => locations.id),
    checkinId: uuid('checkin_id').notNull().references(() => operatorCheckins.id),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    status: slotStatus('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial: a cancelled tick must be regenerable, or checking out would
    // permanently poison those times for that operator.
    uniqueIndex('one_session_per_operator_per_tick')
      .on(t.operatorId, t.startAt)
      .where(sql`${t.status} <> 'cancelled'`),
    index('operator_slots_lookup_idx').on(t.locationId, t.startAt, t.status),
    // AT TIME ZONE 'UTC' keeps the expression immutable, so it is legal in a
    // CHECK and correct regardless of the session's timezone setting.
    check(
      'grid_aligned',
      sql`EXTRACT(minute FROM ${t.startAt} AT TIME ZONE 'UTC') IN (0,15,30,45)
          AND EXTRACT(second FROM ${t.startAt} AT TIME ZONE 'UTC') = 0`,
    ),
  ],
);

export type OperatorCheckin = typeof operatorCheckins.$inferSelect;
export type OperatorSlot = typeof operatorSlots.$inferSelect;
```

Add `export * from './slots';` to `src/infra/db/schema/index.ts`.

- [ ] **Step 3: Generate the migration and verify the partial index**

```bash
pnpm drizzle-kit generate --name slots
```

Open `drizzle/0003_slots.sql` and confirm the unique index carries its `WHERE "status" <> 'cancelled'` predicate and that `grid_aligned` is present. If either is missing, append by hand:

```sql
DROP INDEX IF EXISTS "one_session_per_operator_per_tick";
CREATE UNIQUE INDEX "one_session_per_operator_per_tick"
  ON "operator_slots" ("operator_id", "start_at") WHERE "status" <> 'cancelled';

ALTER TABLE "operator_slots" ADD CONSTRAINT "grid_aligned" CHECK (
  EXTRACT(minute FROM "start_at" AT TIME ZONE 'UTC') IN (0,15,30,45)
  AND EXTRACT(second FROM "start_at" AT TIME ZONE 'UTC') = 0);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:integration`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: operator check-in and materialized slot inventory schema"
```

---

## Task 20: Check-in with Slot Materialization

**Files:**
- Create: `src/modules/presence/presence.repository.ts`, `src/modules/presence/presence.service.ts`, `src/modules/presence/presence.controller.ts`, `src/modules/presence/presence.module.ts`, `src/modules/presence/dto/checkin.dto.ts`
- Modify: `src/app.module.ts`, `test/e2e/authz-matrix.spec.ts`, `src/common/errors/error-codes.ts`
- Test: `test/e2e/checkin.spec.ts`

**Interfaces:**
- Consumes: `gridTicks`/`isGridAligned` (18), `isSameBusinessDay` (18), `LocationsService.requireActive` (17), `operatorSlots`/`operatorCheckins` (19), `requireOperatorId` (Task 14).
- Produces:
  - `PresenceRepository.isWithinTolerance(locationId: string, lat: number, lng: number, meters: number): Promise<boolean>`
  - `PresenceRepository.createCheckinWithSlots(input): Promise<{ checkinId: string; created: Date[]; conflicts: Date[] }>` — on any conflict it instead **throws `CheckinConflict`** (exported from the same file, carrying `conflicts: Date[]`) so the transaction aborts; the returned `conflicts` array is therefore always empty on success
  - `PresenceService.checkIn(operatorId, dto): Promise<{ checkinId: string; locationId: string; availableFrom: string; availableUntil: string; slotsCreated: number }>`
  - `POST /operators/me/checkins`

- [ ] **Step 1: Write the failing check-in e2e test**

Create `test/e2e/checkin.spec.ts`:
```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import { locations, operatorSlots, operators, users } from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';

let app: TestApp;
let locationId: string;

const LAT = 33.3053;
const LNG = 35.7896;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  locationId = uuidv7();
  await getTestDb().insert(locations).values({
    id: locationId,
    code: `loc-${locationId.slice(0, 8)}`,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    geog: makePoint(LNG, LAT) as never,
  });
});

async function makeOperator(approval: 'approved' | 'pending' = 'approved') {
  const userId = uuidv7();
  const operatorId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await getTestDb()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: approval });

  return {
    operatorId,
    auth: `Bearer ${app.app
      .get(TokenService)
      .issueAccessToken({ sub: userId, role: 'operator', operatorId, jti: uuidv7() })}`,
  };
}

const window = (fromIso: string, toIso: string) => ({
  locationId,
  availableFrom: fromIso,
  availableUntil: toIso,
  lat: LAT,
  lng: LNG,
});

describe('POST /operators/me/checkins', () => {
  it('materializes one slot per grid tick in the window', async () => {
    const op = await makeOperator();
    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send({ ...window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'), locationId })
      .expect(201);

    expect(res.body.slotsCreated).toBe(4);

    const rows = await getTestDb()
      .select()
      .from(operatorSlots)
      .where(eq(operatorSlots.operatorId, op.operatorId));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === 'open')).toBe(true);
  });

  it('sets operator presence to online', async () => {
    const op = await makeOperator();
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(201);

    const [row] = await getTestDb().select().from(operators).where(eq(operators.id, op.operatorId));
    expect(row?.presence).toBe('online');
  });

  it('refuses an operator who is not approved', async () => {
    const op = await makeOperator('pending');
    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(403);
    expect(res.body.error.code).toBe('OPERATOR_NOT_APPROVED');
  });

  it('refuses a position far from the location', async () => {
    const op = await makeOperator();
    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send({
        ...window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'),
        lat: 32.0853,
        lng: 34.7818,
      })
      .expect(422);
    expect(res.body.error.code).toBe('NOT_AT_LOCATION');
  });

  it('rejects an off-grid window with 422', async () => {
    const op = await makeOperator();
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:07:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(422);
  });

  it('rejects a window crossing local midnight with 422', async () => {
    const op = await makeOperator();
    // 20:00 UTC is 23:00 local; 22:00 UTC is 01:00 local the next day.
    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T20:00:00.000Z', '2026-09-06T22:00:00.000Z'))
      .expect(422);
    expect(res.body.error.code).toBe('WINDOW_CROSSES_BUSINESS_DAY');
  });

  it('rejects an inactive location', async () => {
    const op = await makeOperator();
    await getTestDb().update(locations).set({ isActive: false }).where(eq(locations.id, locationId));
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(404);
  });

  it('returns 409 with the conflicting ticks rather than a partial check-in', async () => {
    const op = await makeOperator();
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(201);

    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:30:00.000Z', '2026-09-06T08:30:00.000Z'))
      .expect(409);

    expect(res.body.error.code).toBe('CHECKIN_TICK_CONFLICT');
    expect(res.body.error.details.conflicts).toEqual([
      '2026-09-06T07:30:00.000Z',
      '2026-09-06T07:45:00.000Z',
    ]);

    // The whole request rolled back — no partial second check-in survives.
    const rows = await getTestDb()
      .select()
      .from(operatorSlots)
      .where(
        and(eq(operatorSlots.operatorId, op.operatorId), eq(operatorSlots.status, 'open')),
      );
    expect(rows).toHaveLength(4);
  });

  it('rejects a customer token with 403', async () => {
    const customer = `Bearer ${app.app
      .get(TokenService)
      .issueAccessToken({ sub: uuidv7(), role: 'customer', jti: uuidv7() })}`;
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', customer)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — route returns 404

- [ ] **Step 3: Add the new error codes**

Append to `src/common/errors/error-codes.ts`:
```ts
  LOCATION_NOT_FOUND: 'LOCATION_NOT_FOUND',
  SESSION_TYPE_NOT_FOUND: 'SESSION_TYPE_NOT_FOUND',
  NOT_AT_LOCATION: 'NOT_AT_LOCATION',
  WINDOW_CROSSES_BUSINESS_DAY: 'WINDOW_CROSSES_BUSINESS_DAY',
  CHECKIN_TICK_CONFLICT: 'CHECKIN_TICK_CONFLICT',
  CHECKIN_NOT_FOUND: 'CHECKIN_NOT_FOUND',
```

- [ ] **Step 4: Implement the DTO and repository**

`src/modules/presence/dto/checkin.dto.ts`:
```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const checkinSchema = z.object({
  locationId: z.string().uuid(),
  availableFrom: z.coerce.date(),
  availableUntil: z.coerce.date(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export class CheckinDto extends createZodDto(checkinSchema) {}
```

`src/modules/presence/presence.repository.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
   * which ticks collided instead of failing opaquely — and the surrounding
   * transaction guarantees a conflict leaves no partial check-in behind.
   */
  async createCheckinWithSlots(input: {
    operatorId: string;
    locationId: string;
    availableFrom: Date;
    availableUntil: Date;
    lat: number;
    lng: number;
    ticks: Date[];
  }): Promise<{ checkinId: string; created: Date[]; conflicts: Date[] }> {
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
        .onConflictDoNothing({
          target: [operatorSlots.operatorId, operatorSlots.startAt],
          targetWhere: sql`${operatorSlots.status} <> 'cancelled'`,
        })
        .returning({ startAt: operatorSlots.startAt });

      const created = inserted.map((r) => r.startAt);
      const createdMs = new Set(created.map((d) => d.getTime()));
      const conflicts = input.ticks.filter((t) => !createdMs.has(t.getTime()));

      if (conflicts.length > 0) {
        // Roll the whole thing back; the caller turns this into a 409.
        tx.rollback();
      }

      await tx
        .update(operators)
        .set({ presence: 'online', updatedAt: new Date() })
        .where(eq(operators.id, input.operatorId));

      return { checkinId, created, conflicts };
    });
  }

  async findActiveCheckins(operatorId: string) {
    return this.db
      .select()
      .from(operatorCheckins)
      .where(
        and(eq(operatorCheckins.operatorId, operatorId), eq(operatorCheckins.status, 'active')),
      );
  }
}
```

`tx.rollback()` throws, so it aborts the transaction. Catch it in the service and convert to a `ConflictError` carrying the conflicting ticks — compute them *before* rolling back by returning them through the thrown value:

Replace the conflict branch with:
```ts
      if (conflicts.length > 0) {
        throw new CheckinConflict(conflicts);
      }
```

and define at the bottom of the file:
```ts
/** Internal signal: aborts the transaction while carrying the colliding ticks. */
export class CheckinConflict extends Error {
  constructor(readonly conflicts: Date[]) {
    super('checkin tick conflict');
  }
}
```

- [ ] **Step 5: Implement the service and controller**

`src/modules/presence/presence.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ForbiddenError, ValidationError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import { gridTicks, isGridAligned } from '../../common/time/grid';
import { isSameBusinessDay } from '../../common/time/business-day';
import { LocationsService } from '../locations/locations.service';
import { OperatorsRepository } from '../operators/operators.repository';
import { CheckinConflict, PresenceRepository } from './presence.repository';
import type { Env } from '../../infra/config/env.schema';

@Injectable()
export class PresenceService {
  constructor(
    private readonly repo: PresenceRepository,
    private readonly locations: LocationsService,
    private readonly operatorsRepo: OperatorsRepository,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async checkIn(
    operatorId: string,
    dto: { locationId: string; availableFrom: Date; availableUntil: Date; lat: number; lng: number },
  ) {
    const operator = await this.operatorsRepo.findById(operatorId);
    if (operator?.approvalStatus !== 'approved') {
      throw new ForbiddenError(
        ErrorCodes.OPERATOR_NOT_APPROVED,
        'Only approved operators can check in.',
        { approvalStatus: operator?.approvalStatus ?? 'missing' },
      );
    }

    await this.locations.requireActive(dto.locationId);

    const slotMinutes = this.config.get('SLOT_DURATION_MIN', { infer: true });
    const timeZone = this.config.get('BUSINESS_TIMEZONE', { infer: true });

    if (!isGridAligned(dto.availableFrom, slotMinutes) || !isGridAligned(dto.availableUntil, slotMinutes)) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Window is not aligned to the slot grid.', {
        slotMinutes,
      });
    }
    if (dto.availableUntil <= dto.availableFrom) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Window end must follow its start.', {
        field: 'availableUntil',
      });
    }

    // A window crossing local midnight would produce slots that discovery's
    // today-filter silently hides, so reject it rather than create dead rows.
    const lastTick = new Date(dto.availableUntil.getTime() - slotMinutes * 60_000);
    if (!isSameBusinessDay(dto.availableFrom, lastTick, timeZone)) {
      throw new ValidationError(
        ErrorCodes.WINDOW_CROSSES_BUSINESS_DAY,
        'A check-in window must stay within one business day.',
        { timeZone },
      );
    }

    const tolerance = this.config.get('CHECKIN_LOCATION_TOLERANCE_M', { infer: true });
    if (!(await this.repo.isWithinTolerance(dto.locationId, dto.lat, dto.lng, tolerance))) {
      throw new ValidationError(
        ErrorCodes.NOT_AT_LOCATION,
        'Reported position is too far from the location.',
        { toleranceMeters: tolerance },
      );
    }

    const ticks = gridTicks(dto.availableFrom, dto.availableUntil, slotMinutes);

    try {
      const result = await this.repo.createCheckinWithSlots({ operatorId, ...dto, ticks });
      return {
        checkinId: result.checkinId,
        locationId: dto.locationId,
        availableFrom: dto.availableFrom.toISOString(),
        availableUntil: dto.availableUntil.toISOString(),
        slotsCreated: result.created.length,
      };
    } catch (cause) {
      if (cause instanceof CheckinConflict) {
        throw new ConflictError(
          ErrorCodes.CHECKIN_TICK_CONFLICT,
          'You are already committed at some of these times.',
          { conflicts: cause.conflicts.map((d) => d.toISOString()) },
        );
      }
      throw cause;
    }
  }
}
```

`src/modules/presence/presence.controller.ts`:
```ts
import { Body, Controller, Post } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { requireOperatorId } from '../operators/operators.controller';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PresenceService } from './presence.service';
import { CheckinDto } from './dto/checkin.dto';

@Roles('operator')
@Controller('operators/me')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Post('checkins')
  checkIn(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckinDto) {
    return this.presence.checkIn(requireOperatorId(user), dto);
  }
}
```

`src/modules/presence/presence.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module';
import { OperatorsModule } from '../operators/operators.module';
import { PresenceController } from './presence.controller';
import { PresenceRepository } from './presence.repository';
import { PresenceService } from './presence.service';

@Module({
  imports: [LocationsModule, OperatorsModule],
  controllers: [PresenceController],
  providers: [PresenceRepository, PresenceService],
  exports: [PresenceRepository, PresenceService],
})
export class PresenceModule {}
```

Add `PresenceModule` to `src/app.module.ts`.

- [ ] **Step 6: Extend the authorization matrix**

Add to `PROTECTED_ROUTES`:
```ts
  { method: 'post', path: '/operators/me/checkins', allow: ['operator'], body: {} },
```

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm test:integration`
Expected: PASS — 9 tests

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat: operator check-in materializing the slot grid with conflict reporting"
```

---

## Task 21: Check-out, Mid-day Break & Operator Schedule

**Files:**
- Modify: `src/modules/presence/presence.repository.ts`, `src/modules/presence/presence.service.ts`, `src/modules/presence/presence.controller.ts`
- Create: `src/modules/presence/dto/break.dto.ts`
- Modify: `test/e2e/authz-matrix.spec.ts`
- Test: `test/e2e/checkout-break-schedule.spec.ts`

**Interfaces:**
- Consumes: `PresenceRepository` (20), `businessDayBounds` (18).
- Produces:
  - `PresenceRepository.endCheckin(operatorId: string, checkinId: string): Promise<number | null>` — the count of slots cancelled, or **`null` when no such check-in belongs to that operator** (the service turns `null` into 404)
  - `PresenceRepository.bookedSlotsInRange(operatorId: string, from: Date, to: Date): Promise<Array<{ startAt: Date }>>`
  - `PresenceRepository.cancelOpenSlotsInRange(operatorId: string, from: Date, to: Date): Promise<number>`
  - `PresenceRepository.scheduleFor(operatorId: string, dayStart: Date, dayEnd: Date): Promise<Array<{ id: string; operatorId: string; locationId: string; startAt: Date; status: 'open'|'booked'|'cancelled'|'expired' }>>`
  - `POST /operators/me/checkins/:id/end`, `POST /operators/me/breaks`, `GET /operators/me/schedule`

- [ ] **Step 1: Write the failing test**

Create `test/e2e/checkout-break-schedule.spec.ts`:
```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import { locations, operatorSlots, operators, users } from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';

let app: TestApp;
let locationId: string;
const LAT = 33.3053;
const LNG = 35.7896;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  locationId = uuidv7();
  await getTestDb().insert(locations).values({
    id: locationId,
    code: `loc-${locationId.slice(0, 8)}`,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    geog: makePoint(LNG, LAT) as never,
  });
});

async function checkedInOperator(fromIso = '2026-09-06T07:00:00.000Z', toIso = '2026-09-06T09:00:00.000Z') {
  const userId = uuidv7();
  const operatorId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await getTestDb()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });

  const auth = `Bearer ${app.app
    .get(TokenService)
    .issueAccessToken({ sub: userId, role: 'operator', operatorId, jti: uuidv7() })}`;

  const res = await request(app.server)
    .post('/operators/me/checkins')
    .set('Authorization', auth)
    .send({ locationId, availableFrom: fromIso, availableUntil: toIso, lat: LAT, lng: LNG })
    .expect(201);

  return { operatorId, auth, checkinId: res.body.checkinId as string };
}

const openSlots = (operatorId: string) =>
  getTestDb()
    .select()
    .from(operatorSlots)
    .where(and(eq(operatorSlots.operatorId, operatorId), eq(operatorSlots.status, 'open')));

describe('check-out', () => {
  it('cancels open slots and goes offline', async () => {
    const op = await checkedInOperator();
    const res = await request(app.server)
      .post(`/operators/me/checkins/${op.checkinId}/end`)
      .set('Authorization', op.auth)
      .expect(200);

    expect(res.body.slotsCancelled).toBe(8);
    expect(await openSlots(op.operatorId)).toHaveLength(0);

    const [row] = await getTestDb().select().from(operators).where(eq(operators.id, op.operatorId));
    expect(row?.presence).toBe('offline');
  });

  it('leaves booked slots alone — the commitment survives going offline', async () => {
    const op = await checkedInOperator();
    const [slot] = await openSlots(op.operatorId);
    await getTestDb()
      .update(operatorSlots)
      .set({ status: 'booked' })
      .where(eq(operatorSlots.id, slot!.id));

    await request(app.server)
      .post(`/operators/me/checkins/${op.checkinId}/end`)
      .set('Authorization', op.auth)
      .expect(200);

    const [after] = await getTestDb()
      .select()
      .from(operatorSlots)
      .where(eq(operatorSlots.id, slot!.id));
    expect(after?.status).toBe('booked');
  });

  it("refuses to end another operator's check-in", async () => {
    const mine = await checkedInOperator();
    const theirs = await checkedInOperator();
    await request(app.server)
      .post(`/operators/me/checkins/${theirs.checkinId}/end`)
      .set('Authorization', mine.auth)
      .expect(404);
  });
});

describe('mid-day break', () => {
  it('cancels only the open slots inside the range', async () => {
    const op = await checkedInOperator();
    const res = await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:00:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(200);

    expect(res.body.slotsCancelled).toBe(2);
    expect(await openSlots(op.operatorId)).toHaveLength(6);
  });

  it('rejects the break when a booked slot falls inside it', async () => {
    const op = await checkedInOperator();
    const target = (await openSlots(op.operatorId)).find(
      (s) => s.startAt.toISOString() === '2026-09-06T08:00:00.000Z',
    );
    await getTestDb()
      .update(operatorSlots)
      .set({ status: 'booked' })
      .where(eq(operatorSlots.id, target!.id));

    const res = await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:00:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(409);

    expect(res.body.error.code).toBe('BREAK_HAS_BOOKINGS');
    expect(res.body.error.details.conflicts).toEqual(['2026-09-06T08:00:00.000Z']);
    // Nothing was cancelled — the break is all or nothing.
    expect(await openSlots(op.operatorId)).toHaveLength(7);
  });

  it('lets the operator return early by checking in again for the remainder', async () => {
    const op = await checkedInOperator();
    await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:00:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(200);

    // Cancelled rows are excluded from the partial unique index, so these
    // ticks can be regenerated cleanly.
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send({
        locationId,
        availableFrom: '2026-09-06T08:15:00.000Z',
        availableUntil: '2026-09-06T08:30:00.000Z',
        lat: LAT,
        lng: LNG,
      })
      .expect(201);

    expect(await openSlots(op.operatorId)).toHaveLength(7);
  });

  it('rejects an off-grid range with 422', async () => {
    const op = await checkedInOperator();
    await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:07:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(422);
  });
});

describe('operator schedule', () => {
  it('returns the calling operator’s own day only', async () => {
    const mine = await checkedInOperator();
    await checkedInOperator();

    const res = await request(app.server)
      .get('/operators/me/schedule?date=2026-09-06')
      .set('Authorization', mine.auth)
      .expect(200);

    expect(res.body.slots).toHaveLength(8);
    expect(res.body.slots.every((s: { operatorId: string }) => s.operatorId === mine.operatorId)).toBe(true);
  });

  it('returns an empty day when nothing is scheduled', async () => {
    const op = await checkedInOperator();
    const res = await request(app.server)
      .get('/operators/me/schedule?date=2026-09-07')
      .set('Authorization', op.auth)
      .expect(200);
    expect(res.body.slots).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — the three routes return 404

- [ ] **Step 3: Add error codes and the break DTO**

Append to `src/common/errors/error-codes.ts`: `BREAK_HAS_BOOKINGS: 'BREAK_HAS_BOOKINGS',`

`src/modules/presence/dto/break.dto.ts`:
```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const breakSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});

export class BreakDto extends createZodDto(breakSchema) {}
```

- [ ] **Step 4: Extend the repository**

Append to `src/modules/presence/presence.repository.ts`:
```ts
  /**
   * Cancels only this check-in's OPEN slots. Booked slots survive: going
   * offline does not dissolve a commitment to a customer who already booked.
   */
  async endCheckin(operatorId: string, checkinId: string): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      const [checkin] = await tx
        .select()
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

  async bookedSlotsInRange(operatorId: string, from: Date, to: Date) {
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

  async scheduleFor(operatorId: string, dayStart: Date, dayEnd: Date) {
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
```

Extend the drizzle import at the top of the file to `import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';`

- [ ] **Step 5: Extend the service**

Append to `src/modules/presence/presence.service.ts`:
```ts
  async endCheckin(operatorId: string, checkinId: string) {
    const cancelled = await this.repo.endCheckin(operatorId, checkinId);
    if (cancelled === null) {
      // 404 rather than 403: the caller must not learn that someone else's
      // check-in exists under that id.
      throw new NotFoundError(ErrorCodes.CHECKIN_NOT_FOUND, 'No such check-in.');
    }
    return { checkinId, slotsCancelled: cancelled };
  }

  /**
   * Availability is purely which slot rows exist and are open, so a break needs
   * no new state — it cancels rows. Booked slots block the whole request so a
   * break can never become a backdoor for abandoning a committed customer.
   */
  async takeBreak(operatorId: string, from: Date, to: Date) {
    const slotMinutes = this.config.get('SLOT_DURATION_MIN', { infer: true });
    if (!isGridAligned(from, slotMinutes) || !isGridAligned(to, slotMinutes)) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Break range is not grid-aligned.', {
        slotMinutes,
      });
    }
    if (to <= from) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Break end must follow its start.', {
        field: 'to',
      });
    }

    const booked = await this.repo.bookedSlotsInRange(operatorId, from, to);
    if (booked.length > 0) {
      throw new ConflictError(
        ErrorCodes.BREAK_HAS_BOOKINGS,
        'Cancel the bookings in this range before taking a break.',
        { conflicts: booked.map((b) => b.startAt.toISOString()) },
      );
    }

    const cancelled = await this.repo.cancelOpenSlotsInRange(operatorId, from, to);
    return { slotsCancelled: cancelled };
  }

  async schedule(operatorId: string, date: string | undefined) {
    const timeZone = this.config.get('BUSINESS_TIMEZONE', { infer: true });
    const anchor = date ? new Date(`${date}T12:00:00.000Z`) : new Date();
    const { start, end } = businessDayBounds(anchor, timeZone);
    const slots = await this.repo.scheduleFor(operatorId, start, end);
    return { date: date ?? null, timeZone, slots };
  }
```

Add `NotFoundError` and `businessDayBounds` to that file's imports.

- [ ] **Step 6: Add the controller routes**

Append to `src/modules/presence/presence.controller.ts`:
```ts
  @Post('checkins/:id/end')
  end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.presence.endCheckin(requireOperatorId(user), id);
  }

  @Post('breaks')
  takeBreak(@CurrentUser() user: AuthenticatedUser, @Body() dto: BreakDto) {
    return this.presence.takeBreak(requireOperatorId(user), dto.from, dto.to);
  }

  @Get('schedule')
  schedule(@CurrentUser() user: AuthenticatedUser, @Query('date') date?: string) {
    return this.presence.schedule(requireOperatorId(user), date);
  }
```

Add `Get`, `Param`, `ParseUUIDPipe`, `Query` and `BreakDto` to the imports.

- [ ] **Step 7: Extend the authorization matrix**

Add to `PROTECTED_ROUTES`:
```ts
  { method: 'post', path: `/operators/me/checkins/${uuidv7()}/end`, allow: ['operator'] },
  { method: 'post', path: '/operators/me/breaks', allow: ['operator'], body: {} },
  { method: 'get', path: '/operators/me/schedule', allow: ['operator'] },
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm test:integration`
Expected: PASS — 8 tests

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat: check-out, mid-day break with booked-slot guard, operator schedule"
```

---

## Task 22: Geo Discovery

**Files:**
- Create: `src/modules/discovery/discovery.repository.ts`, `src/modules/discovery/discovery.service.ts`, `src/modules/discovery/discovery.controller.ts`, `src/modules/discovery/discovery.module.ts`, `src/modules/discovery/dto/discovery.dto.ts`
- Modify: `src/app.module.ts`
- Test: `test/e2e/discovery.spec.ts`

**Interfaces:**
- Consumes: `locations`/`locationSessionTypes` (16), `operatorSlots` (19), `businessDayBounds` (18).
- Produces:
  - `DiscoveryRepository.nearbyLocations(lat, lng, radiusM): Promise<NearbyLocationRow[]>`
  - `DiscoveryRepository.slotCapacities(locationIds, from, to): Promise<Array<{ locationId; startAt; capacity }>>`
  - `GET /discovery/locations`, `GET /discovery/locations/:id`

- [ ] **Step 1: Write the failing discovery test**

Create `test/e2e/discovery.spec.ts`:
```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import {
  locationSessionTypes,
  locations,
  operatorCheckins,
  operatorSlots,
  operators,
  users,
} from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';
import { createTestApp, type TestApp } from './app.helper';

let app: TestApp;
const LAT = 33.3053;
const LNG = 35.7896;
// Far enough to be outside a 300 m radius but still a real place.
const FAR_LAT = 32.0853;
const FAR_LNG = 34.7818;

// Discovery only returns today's slots, so anchor the fixtures to today.
const todayAt = (hour: number, minute = 0) => {
  const d = new Date();
  d.setUTCHours(hour, minute, 0, 0);
  return d;
};

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

async function makeLocation(opts: { code: string; lat: number; lng: number; active?: boolean }) {
  const id = uuidv7();
  await getTestDb().insert(locations).values({
    id,
    code: opts.code,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    description: { en: 'Nice.', he: 'נחמד.' },
    geog: makePoint(opts.lng, opts.lat) as never,
    isActive: opts.active ?? true,
  });
  return id;
}

async function addSessionType(locationId: string, code: string, price: string) {
  await getTestDb()
    .insert(locationSessionTypes)
    .values({ id: uuidv7(), locationId, code, name: { en: code, he: code }, price });
}

async function addOpenSlot(locationId: string, startAt: Date) {
  const userId = uuidv7();
  const operatorId = uuidv7();
  const checkinId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await getTestDb()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });
  await getTestDb().insert(operatorCheckins).values({
    id: checkinId,
    operatorId,
    locationId,
    availableFrom: startAt,
    availableUntil: new Date(startAt.getTime() + 15 * 60_000),
    checkedInGeog: makePoint(LNG, LAT) as never,
  });
  await getTestDb()
    .insert(operatorSlots)
    .values({ id: uuidv7(), operatorId, locationId, checkinId, startAt });
  return operatorId;
}

describe('GET /discovery/locations', () => {
  it('returns a nearby location with its distance and minimum price', async () => {
    const id = await makeLocation({ code: `near-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    await addSessionType(id, 'extreme', '250.00');
    await addOpenSlot(id, todayAt(20));

    const res = await request(app.server)
      .get(`/discovery/locations?lat=${LAT}&lng=${LNG}`)
      .expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    expect(found.minPrice).toBe('100.00');
    expect(found.distanceM).toBeLessThan(10);
  });

  it('returns localized names as objects carrying every locale', async () => {
    const id = await makeLocation({ code: `loc-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    await addOpenSlot(id, todayAt(20));

    const res = await request(app.server)
      .get(`/discovery/locations?lat=${LAT}&lng=${LNG}`)
      .expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    expect(found.name).toEqual({ en: 'Slope', he: 'מסלול' });
    expect(found.siteName).toEqual({ en: 'Hermon', he: 'חרמון' });
  });

  it('excludes a location outside the radius', async () => {
    const id = await makeLocation({ code: `far-${uuidv7().slice(0, 8)}`, lat: FAR_LAT, lng: FAR_LNG });
    await addOpenSlot(id, todayAt(20));

    const res = await request(app.server)
      .get(`/discovery/locations?lat=${LAT}&lng=${LNG}`)
      .expect(200);
    expect(res.body.locations.find((l: { id: string }) => l.id === id)).toBeUndefined();
  });

  it('excludes an inactive location', async () => {
    const id = await makeLocation({
      code: `inactive-${uuidv7().slice(0, 8)}`,
      lat: LAT,
      lng: LNG,
      active: false,
    });
    await addOpenSlot(id, todayAt(20));

    const res = await request(app.server)
      .get(`/discovery/locations?lat=${LAT}&lng=${LNG}`)
      .expect(200);
    expect(res.body.locations.find((l: { id: string }) => l.id === id)).toBeUndefined();
  });

  it('reports capacity as the number of free operators at a tick', async () => {
    const id = await makeLocation({ code: `cap-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    const at = todayAt(21);
    await addOpenSlot(id, at);
    await addOpenSlot(id, at);

    const res = await request(app.server)
      .get(`/discovery/locations?lat=${LAT}&lng=${LNG}`)
      .expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    const tick = found.slots.find((s: { startAt: string }) => s.startAt === at.toISOString());
    expect(tick.capacity).toBe(2);
  });

  it('omits a slot that is already booked', async () => {
    const id = await makeLocation({ code: `booked-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    const at = todayAt(21, 30);
    const operatorId = await addOpenSlot(id, at);
    await getTestDb().update(operatorSlots).set({ status: 'booked' });

    const res = await request(app.server)
      .get(`/discovery/locations?lat=${LAT}&lng=${LNG}`)
      .expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    expect(found?.slots ?? []).not.toContainEqual(
      expect.objectContaining({ startAt: at.toISOString() }),
    );
    expect(operatorId).toBeTruthy();
  });

  it('rejects missing coordinates with 422', async () => {
    await request(app.server).get('/discovery/locations').expect(422);
  });

  it('is public — no token required', async () => {
    await request(app.server).get(`/discovery/locations?lat=${LAT}&lng=${LNG}`).expect(200);
  });
});

describe('GET /discovery/locations/:id', () => {
  it('returns active session types with prices', async () => {
    const id = await makeLocation({ code: `detail-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    await addSessionType(id, 'extreme', '250.00');
    await addOpenSlot(id, todayAt(22));

    const res = await request(app.server).get(`/discovery/locations/${id}`).expect(200);

    expect(res.body.sessionTypes).toHaveLength(2);
    expect(res.body.sessionTypes[0]).toMatchObject({ code: 'extreme', price: '250.00' });
  });

  it('returns 404 for an inactive location', async () => {
    const id = await makeLocation({
      code: `gone-${uuidv7().slice(0, 8)}`,
      lat: LAT,
      lng: LNG,
      active: false,
    });
    await request(app.server).get(`/discovery/locations/${id}`).expect(404);
  });
});
```

Sort session types by `sortOrder` then `code` so the assertion above is deterministic; seed `extreme` with a lower `sortOrder` if needed, or assert with `expect.arrayContaining`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — `/discovery/locations` returns 404

- [ ] **Step 3: Implement the DTO and repository**

`src/modules/discovery/dto/discovery.dto.ts`:
```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().positive().max(50_000).optional(),
});

export class NearbyQueryDto extends createZodDto(nearbyQuerySchema) {}
```

`src/modules/discovery/discovery.repository.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { makePoint } from '../../infra/db/types';
import type { LocalizedText } from '../../common/localized/localized-text';

export interface NearbyLocationRow {
  id: string;
  code: string;
  site_code: string;
  site_name: LocalizedText;
  name: LocalizedText;
  description: LocalizedText | null;
  distance_m: number;
  min_price: string | null;
  currency: string | null;
}

export interface CapacityRow {
  location_id: string;
  start_at: Date;
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

  /** Capacity is a count of open rows — never a stored number. */
  async slotCapacities(locationIds: string[], from: Date, to: Date): Promise<CapacityRow[]> {
    if (locationIds.length === 0) return [];
    const res = await this.db.execute<CapacityRow>(sql`
      SELECT location_id, start_at, count(*)::int AS capacity
      FROM operator_slots
      WHERE location_id = ANY(${sql.raw(`ARRAY[${locationIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
        AND status = 'open'
        AND start_at >= ${from}
        AND start_at <  ${to}
      GROUP BY location_id, start_at
      ORDER BY start_at ASC
    `);
    return res.rows;
  }
}
```

- [ ] **Step 4: Implement the service and controller**

`src/modules/discovery/discovery.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { businessDayBounds } from '../../common/time/business-day';
import { LocationsRepository } from '../locations/locations.repository';
import { LocationsService } from '../locations/locations.service';
import { DiscoveryRepository } from './discovery.repository';
import type { Env } from '../../infra/config/env.schema';

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly repo: DiscoveryRepository,
    private readonly locationsRepo: LocationsRepository,
    private readonly locations: LocationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Nothing starting sooner than BOOKING_LEAD_TIME_MIN is offered — a session
   * beginning in forty seconds is not bookable in practice.
   */
  private todayWindow() {
    const timeZone = this.config.get('BUSINESS_TIMEZONE', { infer: true });
    const leadMin = this.config.get('BOOKING_LEAD_TIME_MIN', { infer: true });
    const { start, end } = businessDayBounds(new Date(), timeZone);
    const earliest = new Date(Date.now() + leadMin * 60_000);
    return { from: earliest > start ? earliest : start, to: end };
  }

  async nearby(lat: number, lng: number, radius?: number) {
    const radiusM = radius ?? this.config.get('DISCOVERY_RADIUS_M', { infer: true });
    const rows = await this.repo.nearbyLocations(lat, lng, radiusM);

    const { from, to } = this.todayWindow();
    const capacities = await this.repo.slotCapacities(rows.map((r) => r.id), from, to);

    const byLocation = new Map<string, Array<{ startAt: string; capacity: number }>>();
    for (const c of capacities) {
      const list = byLocation.get(c.location_id) ?? [];
      list.push({ startAt: new Date(c.start_at).toISOString(), capacity: Number(c.capacity) });
      byLocation.set(c.location_id, list);
    }

    return {
      radiusM,
      locations: rows.map((r) => ({
        id: r.id,
        code: r.code,
        siteCode: r.site_code,
        siteName: r.site_name,
        name: r.name,
        description: r.description,
        distanceM: Number(r.distance_m),
        minPrice: r.min_price,
        currency: r.currency,
        slots: byLocation.get(r.id) ?? [],
      })),
    };
  }

  async detail(locationId: string) {
    const location = await this.locations.requireActive(locationId);
    const sessionTypes = await this.locationsRepo.listActiveSessionTypes(locationId);
    const { from, to } = this.todayWindow();
    const capacities = await this.repo.slotCapacities([locationId], from, to);

    return {
      ...location,
      sessionTypes: sessionTypes.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        description: t.description,
        price: t.price,
        currency: t.currency,
        sortOrder: t.sortOrder,
      })),
      slots: capacities.map((c) => ({
        startAt: new Date(c.start_at).toISOString(),
        capacity: Number(c.capacity),
      })),
    };
  }
}
```

`src/modules/discovery/discovery.controller.ts`:
```ts
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator';
import { DiscoveryService } from './discovery.service';
import { NearbyQueryDto } from './dto/discovery.dto';

@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  // Public so customers can browse before verifying a phone number; booking
  // still requires a verified account.
  @Public()
  @Get('locations')
  nearby(@Query() query: NearbyQueryDto) {
    return this.discovery.nearby(query.lat, query.lng, query.radius);
  }

  @Public()
  @Get('locations/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.discovery.detail(id);
  }
}
```

`src/modules/discovery/discovery.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryRepository } from './discovery.repository';
import { DiscoveryService } from './discovery.service';

@Module({
  imports: [LocationsModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryRepository, DiscoveryService],
  exports: [DiscoveryRepository],
})
export class DiscoveryModule {}
```

Add `DiscoveryModule` to `src/app.module.ts`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test:integration`
Expected: PASS — 10 tests

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: geo discovery with ST_DWithin, slot capacities and minimum prices"
```

---

## Task 23: The Booking State Machine

**Files:**
- Create: `src/modules/bookings/domain/state-machine.ts`, `src/modules/bookings/domain/types.ts`
- Test: `src/modules/bookings/domain/state-machine.spec.ts`

**Interfaces:**
- Consumes: nothing — this module imports no Nest, no database, and no clock.
- Produces:
  - `BookingStatus = 'confirmed'|'customer_ready'|'in_progress'|'completed'|'cancelled'|'no_show'|'expired'`
  - `BookingEvent = 'CUSTOMER_ACK'|'START'|'END_SESSION'|'CANCEL'|'MARK_NO_SHOW'|'EXPIRE'`
  - `ActorKind = 'customer'|'operator'|'admin'|'system'`
  - `transition(current, event, actor, ctx): TransitionResult` where `ctx = { now: Date; startAt: Date; lateCancellationMin: number; bookingLeadTimeMin: number }`
  - `TransitionResult = { ok: true; next: BookingStatus; stampField: string; lateCancellation: boolean; releaseSlot: boolean } | { ok: false; code: string }`

- [ ] **Step 1: Write the exhaustive failing test**

Create `src/modules/bookings/domain/state-machine.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { transition } from './state-machine';
import type { ActorKind, BookingEvent, BookingStatus } from './types';

const ALL_STATUSES: BookingStatus[] = [
  'confirmed',
  'customer_ready',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'expired',
];
const ALL_EVENTS: BookingEvent[] = [
  'CUSTOMER_ACK',
  'START',
  'END_SESSION',
  'CANCEL',
  'MARK_NO_SHOW',
  'EXPIRE',
];

const START_AT = new Date('2026-09-06T10:00:00.000Z');
const ctx = (nowIso: string) => ({
  now: new Date(nowIso),
  startAt: START_AT,
  lateCancellationMin: 60,
  bookingLeadTimeMin: 5,
});
const WELL_BEFORE = ctx('2026-09-06T06:00:00.000Z');
const JUST_BEFORE = ctx('2026-09-06T09:58:00.000Z');

/** Every cell the spec's table fills in. */
const ALLOWED: Array<[BookingStatus, BookingEvent, ActorKind, BookingStatus]> = [
  ['confirmed', 'CUSTOMER_ACK', 'customer', 'customer_ready'],
  ['confirmed', 'START', 'operator', 'in_progress'],
  ['customer_ready', 'START', 'operator', 'in_progress'],
  ['in_progress', 'END_SESSION', 'operator', 'completed'],
  ['confirmed', 'CANCEL', 'customer', 'cancelled'],
  ['confirmed', 'CANCEL', 'operator', 'cancelled'],
  ['confirmed', 'CANCEL', 'admin', 'cancelled'],
  ['customer_ready', 'CANCEL', 'customer', 'cancelled'],
  ['customer_ready', 'CANCEL', 'operator', 'cancelled'],
  ['customer_ready', 'CANCEL', 'admin', 'cancelled'],
  ['confirmed', 'MARK_NO_SHOW', 'operator', 'no_show'],
  ['customer_ready', 'MARK_NO_SHOW', 'operator', 'no_show'],
  ['confirmed', 'EXPIRE', 'system', 'expired'],
  ['customer_ready', 'EXPIRE', 'system', 'expired'],
];

const allowedKey = (s: BookingStatus, e: BookingEvent, a: ActorKind) => `${s}|${e}|${a}`;
const ALLOWED_KEYS = new Set(ALLOWED.map(([s, e, a]) => allowedKey(s, e, a)));

describe('booking state machine — allowed transitions', () => {
  it.each(ALLOWED)('%s + %s by %s becomes %s', (from, event, actor, expected) => {
    const result = transition(from, event, actor, WELL_BEFORE);
    expect(result).toMatchObject({ ok: true, next: expected });
  });

  it('stamps the right timestamp field for each transition', () => {
    expect(transition('confirmed', 'CUSTOMER_ACK', 'customer', WELL_BEFORE)).toMatchObject({
      stampField: 'readyAckAt',
    });
    expect(transition('confirmed', 'START', 'operator', WELL_BEFORE)).toMatchObject({
      stampField: 'startedAt',
    });
    expect(transition('in_progress', 'END_SESSION', 'operator', WELL_BEFORE)).toMatchObject({
      stampField: 'sessionEndAt',
    });
    expect(transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE)).toMatchObject({
      stampField: 'cancelledAt',
    });
  });
});

describe('booking state machine — every forbidden cell', () => {
  const forbidden = ALL_STATUSES.flatMap((status) =>
    ALL_EVENTS.flatMap((event) =>
      (['customer', 'operator', 'admin', 'system'] as ActorKind[])
        .filter((actor) => !ALLOWED_KEYS.has(allowedKey(status, event, actor)))
        .map((actor) => ({ status, event, actor })),
    ),
  );

  // The spec requires every empty cell be a test, not merely every filled one.
  it.each(forbidden)('rejects $status + $event by $actor', ({ status, event, actor }) => {
    expect(transition(status, event, actor, WELL_BEFORE)).toMatchObject({ ok: false });
  });

  it('covers the whole grid', () => {
    expect(forbidden.length + ALLOWED.length).toBe(
      ALL_STATUSES.length * ALL_EVENTS.length * 4,
    );
  });
});

describe('cancellation policy', () => {
  it('is not late and releases the slot when cancelled well in advance', () => {
    expect(transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE)).toMatchObject({
      lateCancellation: false,
      releaseSlot: true,
    });
  });

  it('is late and does not release the slot close to the start', () => {
    expect(transition('confirmed', 'CANCEL', 'customer', JUST_BEFORE)).toMatchObject({
      lateCancellation: true,
      releaseSlot: false,
    });
  });

  it('marks late exactly at the threshold boundary', () => {
    // Exactly 60 minutes before start is already inside the late window.
    const atThreshold = ctx('2026-09-06T09:00:00.000Z');
    expect(transition('confirmed', 'CANCEL', 'customer', atThreshold)).toMatchObject({
      lateCancellation: true,
    });
  });

  it('never releases a slot for a no-show', () => {
    expect(transition('confirmed', 'MARK_NO_SHOW', 'operator', WELL_BEFORE)).toMatchObject({
      releaseSlot: false,
    });
  });
});

describe('purity', () => {
  it('reads time only from ctx — the same inputs always give the same answer', () => {
    const a = transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE);
    const b = transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE);
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the types and machine**

`src/modules/bookings/domain/types.ts`:
```ts
export type BookingStatus =
  | 'confirmed'
  | 'customer_ready'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'expired';

export type BookingEvent =
  | 'CUSTOMER_ACK'
  | 'START'
  | 'END_SESSION'
  | 'CANCEL'
  | 'MARK_NO_SHOW'
  | 'EXPIRE';

export type ActorKind = 'customer' | 'operator' | 'admin' | 'system';

export interface TransitionContext {
  now: Date;
  startAt: Date;
  lateCancellationMin: number;
  bookingLeadTimeMin: number;
}

export type TransitionResult =
  | {
      ok: true;
      next: BookingStatus;
      stampField: 'readyAckAt' | 'startedAt' | 'sessionEndAt' | 'cancelledAt' | 'completedAt';
      lateCancellation: boolean;
      /** Whether the underlying operator_slot returns to 'open' for resale. */
      releaseSlot: boolean;
    }
  | { ok: false; code: string };
```

`src/modules/bookings/domain/state-machine.ts`:
```ts
import type {
  ActorKind,
  BookingEvent,
  BookingStatus,
  TransitionContext,
  TransitionResult,
} from './types';

interface Rule {
  from: BookingStatus[];
  actors: ActorKind[];
  next: BookingStatus;
  stampField: 'readyAckAt' | 'startedAt' | 'sessionEndAt' | 'cancelledAt' | 'completedAt';
}

/**
 * The whole lifecycle, declared once. Adding a state or an event means editing
 * this table and nothing else — and the test suite walks the full cartesian
 * product, so any cell not listed here is provably rejected.
 */
const RULES: Record<BookingEvent, Rule> = {
  CUSTOMER_ACK: {
    from: ['confirmed'],
    actors: ['customer'],
    next: 'customer_ready',
    stampField: 'readyAckAt',
  },
  // START is allowed from 'confirmed' as well as 'customer_ready': readiness
  // reminders arrive with the scheduler in sub-project #3, so until then a
  // missing acknowledgement must never block a real session.
  START: {
    from: ['confirmed', 'customer_ready'],
    actors: ['operator'],
    next: 'in_progress',
    stampField: 'startedAt',
  },
  END_SESSION: {
    from: ['in_progress'],
    actors: ['operator'],
    next: 'completed',
    stampField: 'sessionEndAt',
  },
  CANCEL: {
    from: ['confirmed', 'customer_ready'],
    actors: ['customer', 'operator', 'admin'],
    next: 'cancelled',
    stampField: 'cancelledAt',
  },
  MARK_NO_SHOW: {
    from: ['confirmed', 'customer_ready'],
    actors: ['operator'],
    next: 'no_show',
    stampField: 'cancelledAt',
  },
  EXPIRE: {
    from: ['confirmed', 'customer_ready'],
    actors: ['system'],
    next: 'expired',
    stampField: 'cancelledAt',
  },
};

export function transition(
  current: BookingStatus,
  event: BookingEvent,
  actor: ActorKind,
  ctx: TransitionContext,
): TransitionResult {
  const rule = RULES[event];
  if (!rule.from.includes(current)) {
    return { ok: false, code: 'INVALID_TRANSITION' };
  }
  if (!rule.actors.includes(actor)) {
    return { ok: false, code: 'ACTOR_NOT_PERMITTED' };
  }

  const minutesUntilStart = (ctx.startAt.getTime() - ctx.now.getTime()) / 60_000;

  // Late cancellation is recorded for future penalty logic only. No penalties
  // in MVP: payment happens after the session, so there is nothing to charge.
  const lateCancellation =
    event === 'CANCEL' && minutesUntilStart <= ctx.lateCancellationMin;

  // Inventory returns to sale only while there is still meaningful notice.
  const releaseSlot = event === 'CANCEL' && minutesUntilStart > ctx.bookingLeadTimeMin;

  return { ok: true, next: rule.next, stampField: rule.stampField, lateCancellation, releaseSlot };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:unit`
Expected: PASS — 14 allowed cases, 154 forbidden cases, plus the policy and purity tests

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: pure booking state machine with exhaustive transition table"
```

---

## Task 24: Bookings Schema & Atomic Fair Assignment

**Files:**
- Create: `src/infra/db/schema/bookings.ts`, `src/modules/bookings/bookings.repository.ts`, `src/modules/bookings/bookings.service.ts`, `src/modules/bookings/bookings.controller.ts`, `src/modules/bookings/bookings.module.ts`, `src/modules/bookings/dto/create-booking.dto.ts`
- Modify: `src/infra/db/schema/index.ts`, `src/app.module.ts`, `src/common/errors/error-codes.ts`, `test/e2e/authz-matrix.spec.ts`
- Create: `drizzle/0004_bookings.sql`
- Test: `test/integration/booking-concurrency.spec.ts`, `test/e2e/booking-create.spec.ts`

**Interfaces:**
- Consumes: `operatorSlots` (19), `locationSessionTypes` (17), `businessDayBounds` (18), `isGridAligned` (18).
- Produces:
  - drizzle table `bookings`, enums `bookingStatus`, `actorKind`, type `Booking`
  - `BookingsRepository.createBooking(input): Promise<Booking | null>` — `null` means no slot was available
  - `POST /bookings`

- [ ] **Step 1: Write the failing concurrency test — the one that justifies the design**

Create `test/integration/booking-concurrency.spec.ts`:
```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from './db.helper';
import {
  bookings,
  locationSessionTypes,
  locations,
  operatorCheckins,
  operatorSlots,
  operators,
  users,
} from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';
import { BookingsRepository } from '../../src/modules/bookings/bookings.repository';

const db = () => getTestDb();
const START_AT = new Date('2026-09-06T10:00:00.000Z');
const DAY_START = new Date('2026-09-05T21:00:00.000Z');
const DAY_END = new Date('2026-09-06T21:00:00.000Z');

let repo: BookingsRepository;
let locationId: string;
let sessionTypeId: string;

async function seedOperatorWithSlot(startAt: Date) {
  const userId = uuidv7();
  const operatorId = uuidv7();
  const checkinId = uuidv7();
  await db()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await db()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });
  await db().insert(operatorCheckins).values({
    id: checkinId,
    operatorId,
    locationId,
    availableFrom: startAt,
    availableUntil: new Date(startAt.getTime() + 15 * 60_000),
    checkedInGeog: makePoint(35.7896, 33.3053) as never,
  });
  await db()
    .insert(operatorSlots)
    .values({ id: uuidv7(), operatorId, locationId, checkinId, startAt });
  return operatorId;
}

async function seedCustomer() {
  const id = uuidv7();
  await db()
    .insert(users)
    .values({ id, role: 'customer', phone: `+9725${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`, phoneVerifiedAt: new Date() });
  return id;
}

beforeEach(async () => {
  repo = new BookingsRepository(db() as never);

  locationId = uuidv7();
  await db().insert(locations).values({
    id: locationId,
    code: `loc-${locationId.slice(0, 8)}`,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    geog: makePoint(35.7896, 33.3053) as never,
  });

  sessionTypeId = uuidv7();
  await db().insert(locationSessionTypes).values({
    id: sessionTypeId,
    locationId,
    code: 'mild',
    name: { en: 'Mild', he: 'רגוע' },
    price: '100.00',
  });
});

const attempt = async (customerId: string) =>
  repo.createBooking({
    locationId,
    startAt: START_AT,
    sessionTypeId,
    customerId,
    dayStart: DAY_START,
    dayEnd: DAY_END,
  });

describe('booking concurrency', () => {
  it('lets exactly 2 of 12 concurrent attempts win when capacity is 2', async () => {
    await seedOperatorWithSlot(START_AT);
    await seedOperatorWithSlot(START_AT);

    const customers = await Promise.all(Array.from({ length: 12 }, () => seedCustomer()));
    const results = await Promise.all(customers.map((c) => attempt(c)));

    const won = results.filter((r) => r !== null);
    expect(won).toHaveLength(2);
    expect(results.filter((r) => r === null)).toHaveLength(10);

    // No mock can tell you whether FOR UPDATE SKIP LOCKED behaves.
    const rows = await db().select().from(bookings);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.operatorId)).size).toBe(2);
  });

  it('marks both slots booked and leaves none open', async () => {
    await seedOperatorWithSlot(START_AT);
    await seedOperatorWithSlot(START_AT);

    const customers = await Promise.all(Array.from({ length: 6 }, () => seedCustomer()));
    await Promise.all(customers.map((c) => attempt(c)));

    const open = await db()
      .select()
      .from(operatorSlots)
      .where(and(eq(operatorSlots.startAt, START_AT), eq(operatorSlots.status, 'open')));
    expect(open).toHaveLength(0);
  });

  it('returns null rather than throwing when nothing is available', async () => {
    const customer = await seedCustomer();
    expect(await attempt(customer)).toBeNull();
  });

  it('assigns the operator with the fewest bookings today', async () => {
    const busy = await seedOperatorWithSlot(START_AT);
    const idle = await seedOperatorWithSlot(START_AT);

    // Give `busy` an earlier booking today so the fairness ORDER BY must skip it.
    const earlier = new Date('2026-09-06T09:00:00.000Z');
    const busyCheckin = (
      await db().select().from(operatorCheckins).where(eq(operatorCheckins.operatorId, busy))
    )[0]!;
    const earlierSlot = uuidv7();
    await db().insert(operatorSlots).values({
      id: earlierSlot,
      operatorId: busy,
      locationId,
      checkinId: busyCheckin.id,
      startAt: earlier,
      status: 'booked',
    });
    await db().insert(bookings).values({
      id: uuidv7(),
      operatorSlotId: earlierSlot,
      customerId: await seedCustomer(),
      operatorId: busy,
      locationId,
      locationSessionTypeId: sessionTypeId,
      priceSnapshot: '100.00',
      currency: 'ILS',
      startAt: earlier,
    });

    const booking = await attempt(await seedCustomer());
    expect(booking?.operatorId).toBe(idle);
  });

  it('snapshots the price so later edits do not change what is owed', async () => {
    await seedOperatorWithSlot(START_AT);
    const booking = await attempt(await seedCustomer());

    await db()
      .update(locationSessionTypes)
      .set({ price: '999.00' })
      .where(eq(locationSessionTypes.id, sessionTypeId));

    const [row] = await db().select().from(bookings).where(eq(bookings.id, booking!.id));
    expect(row?.priceSnapshot).toBe('100.00');
  });

  it('refuses to book the same customer into two locations at one tick', async () => {
    await seedOperatorWithSlot(START_AT);
    const other = uuidv7();
    await db().insert(locations).values({
      id: other,
      code: `loc-${other.slice(0, 8)}`,
      siteCode: 'hermon',
      siteName: { en: 'Hermon', he: 'חרמון' },
      name: { en: 'Other Slope', he: 'מסלול אחר' },
      geog: makePoint(35.7897, 33.3054) as never,
    });

    const customer = await seedCustomer();
    expect(await attempt(customer)).not.toBeNull();

    // The operator-side constraint does not cover the customer side; at a ski
    // site with adjacent locations this is an easy accidental double-book.
    const previousLocation = locationId;
    locationId = other;
    sessionTypeId = uuidv7();
    await db().insert(locationSessionTypes).values({
      id: sessionTypeId,
      locationId: other,
      code: 'mild',
      name: { en: 'Mild', he: 'רגוע' },
      price: '100.00',
    });
    await seedOperatorWithSlot(START_AT);

    await expect(attempt(customer)).rejects.toThrow();
    expect(previousLocation).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — `bookings` is not exported and `BookingsRepository` does not exist

- [ ] **Step 3: Implement the bookings schema**

`src/infra/db/schema/bookings.ts`:
```ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { locationSessionTypes, locations } from './locations';
import { operatorSlots } from './slots';
import { operators } from './operators';
import { users } from './users';

export const bookingStatus = pgEnum('booking_status', [
  'confirmed',
  'customer_ready',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'expired',
]);
export const actorKind = pgEnum('actor_kind', ['customer', 'operator', 'admin', 'system']);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey(),
    // Belt to the SKIP LOCKED braces: even if the optimistic selection were
    // ever wrong, the database refuses a second booking for the same slot.
    operatorSlotId: uuid('operator_slot_id').notNull().unique().references(() => operatorSlots.id),
    customerId: uuid('customer_id').notNull().references(() => users.id),
    operatorId: uuid('operator_id').notNull().references(() => operators.id),
    locationId: uuid('location_id').notNull().references(() => locations.id),
    locationSessionTypeId: uuid('location_session_type_id')
      .notNull()
      .references(() => locationSessionTypes.id),
    priceSnapshot: numeric('price_snapshot', { precision: 10, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    status: bookingStatus('status').notNull().default('confirmed'),
    lateCancellation: boolean('late_cancellation').notNull().default(false),
    cancelledBy: actorKind('cancelled_by'),
    cancellationReason: text('cancellation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    readyAckAt: timestamp('ready_ack_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    sessionEndAt: timestamp('session_end_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('bookings_customer_idx').on(t.customerId, t.startAt.desc()),
    index('bookings_operator_idx').on(t.operatorId, t.startAt),
    uniqueIndex('customer_one_booking_per_tick')
      .on(t.customerId, t.startAt)
      .where(sql`${t.status} IN ('confirmed','customer_ready','in_progress')`),
  ],
);

export type Booking = typeof bookings.$inferSelect;
```

Add `export * from './bookings';` to `src/infra/db/schema/index.ts`.

- [ ] **Step 4: Generate the migration and verify the partial unique index**

```bash
pnpm drizzle-kit generate --name bookings
```

Confirm `drizzle/0004_bookings.sql` carries the predicate; append if missing:
```sql
DROP INDEX IF EXISTS "customer_one_booking_per_tick";
CREATE UNIQUE INDEX "customer_one_booking_per_tick"
  ON "bookings" ("customer_id", "start_at")
  WHERE "status" IN ('confirmed','customer_ready','in_progress');
```

- [ ] **Step 5: Implement the fairness query**

`src/modules/bookings/bookings.repository.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { bookings, locationSessionTypes, operatorSlots, type Booking } from '../../infra/db/schema';

export interface CreateBookingInput {
  locationId: string;
  startAt: Date;
  sessionTypeId: string;
  customerId: string;
  dayStart: Date;
  dayEnd: Date;
}

@Injectable()
export class BookingsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Selects a free slot AND assigns the fairest operator in one statement.
   *
   * FOR UPDATE SKIP LOCKED is what makes this safe under load: a concurrent
   * transaction holding the best row is skipped rather than blocking, so the
   * next-best operator is picked instead of the request serializing or failing.
   * Capacity is enforced by row existence — zero rows means "no longer
   * available" — never by counting.
   *
   * The load subquery counts every booking assigned for today, including
   * upcoming ones. Counting only completed sessions would route every advance
   * booking to the same operator, since all operators sit at zero.
   *
   * Returns null when no slot is free. Throws on the customer-double-book
   * unique index, which the caller maps to 409.
   */
  async createBooking(input: CreateBookingInput): Promise<Booking | null> {
    return this.db.transaction(async (tx) => {
      const picked = await tx.execute<{ id: string; operator_id: string }>(sql`
        SELECT s.id, s.operator_id
        FROM operator_slots s
        LEFT JOIN LATERAL (
          SELECT count(*) AS n
          FROM bookings b
          WHERE b.operator_id = s.operator_id
            AND b.start_at >= ${input.dayStart}
            AND b.start_at <  ${input.dayEnd}
            AND b.status <> 'cancelled'
        ) load ON true
        WHERE s.location_id = ${input.locationId}
          AND s.start_at    = ${input.startAt}
          AND s.status      = 'open'
        ORDER BY load.n ASC, random()
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);

      const slot = picked.rows[0];
      if (!slot) return null;

      await tx
        .update(operatorSlots)
        .set({ status: 'booked', updatedAt: new Date() })
        .where(eq(operatorSlots.id, slot.id));

      const [sessionType] = await tx
        .select({ price: locationSessionTypes.price, currency: locationSessionTypes.currency })
        .from(locationSessionTypes)
        .where(eq(locationSessionTypes.id, input.sessionTypeId));

      const [booking] = await tx
        .insert(bookings)
        .values({
          id: uuidv7(),
          operatorSlotId: slot.id,
          customerId: input.customerId,
          operatorId: slot.operator_id,
          locationId: input.locationId,
          locationSessionTypeId: input.sessionTypeId,
          // Snapshotted, so an admin editing the price later cannot change
          // what an already-booked customer owes.
          priceSnapshot: sessionType!.price,
          currency: sessionType!.currency,
          startAt: input.startAt,
        })
        .returning();

      return booking!;
    });
  }

  async findById(id: string): Promise<Booking | undefined> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    return row;
  }
}
```

- [ ] **Step 6: Run the concurrency test to verify it passes**

Run: `pnpm test:integration -t 'booking concurrency'`
Expected: PASS — 6 tests. If "exactly 2 of 12" fails with more than 2 winners, the `FOR UPDATE SKIP LOCKED` clause is missing or the statement escaped its transaction.

- [ ] **Step 7: Write the failing endpoint test**

Create `test/e2e/booking-create.spec.ts` following the same fixture pattern as `test/e2e/discovery.spec.ts` (seed a location, a session type, an operator with an open slot at a today-anchored tick, and a phone-verified customer token). Assert:

```ts
  it('creates a confirmed booking', async () => { /* expect 201, status 'confirmed' */ });
  it('returns 409 SLOT_UNAVAILABLE when nothing is free', async () => { /* no slots seeded */ });
  it('returns 409 when the customer already holds that tick', async () => { /* book twice */ });
  it('rejects a session type from another location with 422', async () => { /* mismatched ids */ });
  it('rejects an inactive session type with 422', async () => { /* is_active false */ });
  it('rejects an off-grid start_at with 422', async () => { /* :07 */ });
  it('rejects a start_at inside the lead time with 422', async () => { /* now + 1 min */ });
  it('rejects an unverified customer with 403', async () => { /* phone_verified_at null */ });
  it('rejects an operator token with 403', async () => { /* role operator */ });
```

- [ ] **Step 8: Implement the DTO, service, and controller**

Append to `src/common/errors/error-codes.ts`:
```ts
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  CUSTOMER_ALREADY_BOOKED: 'CUSTOMER_ALREADY_BOOKED',
  PHONE_NOT_VERIFIED: 'PHONE_NOT_VERIFIED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  ACTOR_NOT_PERMITTED: 'ACTOR_NOT_PERMITTED',
```

`src/modules/bookings/dto/create-booking.dto.ts`:
```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createBookingSchema = z.object({
  locationId: z.string().uuid(),
  startAt: z.coerce.date(),
  locationSessionTypeId: z.string().uuid(),
});

export class CreateBookingDto extends createZodDto(createBookingSchema) {}
```

`src/modules/bookings/bookings.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ForbiddenError, ValidationError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import { isGridAligned } from '../../common/time/grid';
import { businessDayBounds } from '../../common/time/business-day';
import { isUniqueViolation } from '../locations/locations.service';
import { LocationsRepository } from '../locations/locations.repository';
import { UsersRepository } from '../users/users.repository';
import { BookingsRepository } from './bookings.repository';
import type { Env } from '../../infra/config/env.schema';

@Injectable()
export class BookingsService {
  constructor(
    private readonly repo: BookingsRepository,
    private readonly locationsRepo: LocationsRepository,
    private readonly usersRepo: UsersRepository,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async create(
    customerId: string,
    dto: { locationId: string; startAt: Date; locationSessionTypeId: string },
  ) {
    const customer = await this.usersRepo.findById(customerId);
    if (!customer?.phoneVerifiedAt) {
      throw new ForbiddenError(
        ErrorCodes.PHONE_NOT_VERIFIED,
        'Verify your phone number before booking.',
      );
    }

    const slotMinutes = this.config.get('SLOT_DURATION_MIN', { infer: true });
    if (!isGridAligned(dto.startAt, slotMinutes)) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Start time is not on the slot grid.', {
        field: 'startAt',
        slotMinutes,
      });
    }

    const leadMin = this.config.get('BOOKING_LEAD_TIME_MIN', { infer: true });
    if (dto.startAt.getTime() < Date.now() + leadMin * 60_000) {
      throw new ValidationError(
        ErrorCodes.VALIDATION_FAILED,
        'That start time is too soon to book.',
        { field: 'startAt', leadTimeMinutes: leadMin },
      );
    }

    const sessionType = await this.locationsRepo.findSessionType(dto.locationSessionTypeId);
    if (!sessionType || sessionType.locationId !== dto.locationId || !sessionType.isActive) {
      throw new ValidationError(
        ErrorCodes.SESSION_TYPE_NOT_FOUND,
        'That session type is not offered at this location.',
        { field: 'locationSessionTypeId' },
      );
    }

    const { start, end } = businessDayBounds(
      dto.startAt,
      this.config.get('BUSINESS_TIMEZONE', { infer: true }),
    );

    try {
      const booking = await this.repo.createBooking({
        locationId: dto.locationId,
        startAt: dto.startAt,
        sessionTypeId: dto.locationSessionTypeId,
        customerId,
        dayStart: start,
        dayEnd: end,
      });

      if (!booking) {
        throw new ConflictError(ErrorCodes.SLOT_UNAVAILABLE, 'That slot is no longer available.', {
          startAt: dto.startAt.toISOString(),
        });
      }
      return booking;
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new ConflictError(
          ErrorCodes.CUSTOMER_ALREADY_BOOKED,
          'You already have a booking at that time.',
          { startAt: dto.startAt.toISOString() },
        );
      }
      throw cause;
    }
  }
}
```

`src/modules/bookings/bookings.controller.ts`:
```ts
import { Body, Controller, Post } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Roles('customer')
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBookingDto) {
    return this.bookings.create(user.userId, dto);
  }
}
```

`src/modules/bookings/bookings.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module';
import { UsersModule } from '../users/users.module';
import { BookingsController } from './bookings.controller';
import { BookingsRepository } from './bookings.repository';
import { BookingsService } from './bookings.service';

@Module({
  imports: [LocationsModule, UsersModule],
  controllers: [BookingsController],
  providers: [BookingsRepository, BookingsService],
  exports: [BookingsRepository, BookingsService],
})
export class BookingsModule {}
```

Add `BookingsModule` to `src/app.module.ts`, and `{ method: 'post', path: '/bookings', allow: ['customer'], body: {} }` to `PROTECTED_ROUTES`.

- [ ] **Step 9: Run the full suite to verify it passes**

Run: `pnpm test:integration`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "feat: bookings schema and atomic booking with fair operator assignment"
```

---

## Task 25: Booking Lifecycle Endpoints & Presence Maintenance

**Files:**
- Modify: `src/modules/bookings/bookings.repository.ts`, `src/modules/bookings/bookings.service.ts`, `src/modules/bookings/bookings.controller.ts`
- Create: `src/modules/bookings/dto/cancel-booking.dto.ts`
- Modify: `test/e2e/authz-matrix.spec.ts`
- Test: `test/e2e/booking-lifecycle.spec.ts`

**Interfaces:**
- Consumes: `transition` (23), `BookingsRepository` (24).
- Produces:
  - `BookingsRepository.applyTransition(bookingId, result, actor, reason): Promise<Booking>` — updates status, stamps the timestamp, maintains `operators.presence`, and releases the slot when instructed, all in one transaction
  - `BookingsService.act(bookingId, event, actor, actorUserId, reason?)`
  - `POST /bookings/:id/{ack,start,end,cancel,no-show}`

- [ ] **Step 1: Write the failing lifecycle test**

Create `test/e2e/booking-lifecycle.spec.ts`. Reuse the Task 24 fixture helpers, then assert:

```ts
  it('customer ack moves confirmed to customer_ready and stamps readyAckAt', /* 200 */);
  it('operator start moves to in_progress and sets presence to in_session', /* 200 */);
  it('operator start is allowed straight from confirmed, without an ack', /* 200 */);
  it('operator end moves to completed, stamps sessionEndAt, returns presence to online', /* 200 */);
  it('end returns presence to offline when the check-in has already ended', /* 200 */);
  it('rejects ack on an in_progress booking with 409 INVALID_TRANSITION', /* 409 */);
  it('rejects start by the customer with 409 ACTOR_NOT_PERMITTED', /* 409 */);
  it("rejects any action by an unrelated customer with 403", /* 403 */);
  it("rejects any action by an unassigned operator with 403", /* 403 */);
  it('early cancel releases the slot back to open and is not late', /* slot status open */);
  it('late cancel keeps the slot cancelled and stamps late_cancellation', /* boolean true */);
  it('cancel records who cancelled and why', /* cancelledBy, cancellationReason */);
  it('no_show does not release the slot', /* slot stays booked */);
```

Every assertion above maps to a row in the spec's §5.5 table or a policy in §5.6, so none of them may be dropped.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — the five lifecycle routes return 404

- [ ] **Step 3: Implement the transition persistence**

Append to `src/modules/bookings/bookings.repository.ts`:
```ts
  /**
   * Persists a decision the pure state machine already made. The service never
   * decides here; this method only writes.
   *
   * operators.presence is maintained in the SAME transaction as the status
   * change, so presence can never disagree with the booking it describes.
   * START is the only thing that ever sets 'in_session'.
   */
  async applyTransition(
    bookingId: string,
    result: { next: BookingStatus; stampField: string; lateCancellation: boolean; releaseSlot: boolean },
    actor: ActorKind,
    reason: string | null,
  ): Promise<Booking> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const patch: Record<string, unknown> = {
        status: result.next,
        updatedAt: now,
        [result.stampField]: now,
      };

      if (result.next === 'completed') patch.completedAt = now;
      if (result.next === 'cancelled') {
        patch.cancelledBy = actor;
        patch.cancellationReason = reason;
        patch.lateCancellation = result.lateCancellation;
      }

      const [updated] = await tx
        .update(bookings)
        .set(patch as never)
        .where(eq(bookings.id, bookingId))
        .returning();

      const booking = updated!;

      // Cancellation returns inventory to sale only while there is still
      // meaningful notice; otherwise the slot stays withdrawn.
      if (result.releaseSlot) {
        await tx
          .update(operatorSlots)
          .set({ status: 'open', updatedAt: now })
          .where(eq(operatorSlots.id, booking.operatorSlotId));
      } else if (result.next === 'cancelled') {
        await tx
          .update(operatorSlots)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(operatorSlots.id, booking.operatorSlotId));
      }

      if (result.next === 'in_progress') {
        await tx
          .update(operators)
          .set({ presence: 'in_session', updatedAt: now })
          .where(eq(operators.id, booking.operatorId));
      } else if (result.next === 'completed') {
        // Back to online, unless the operator's check-in has since ended.
        const [active] = await tx
          .select({ id: operatorCheckins.id })
          .from(operatorCheckins)
          .where(
            and(
              eq(operatorCheckins.operatorId, booking.operatorId),
              eq(operatorCheckins.status, 'active'),
            ),
          )
          .limit(1);

        await tx
          .update(operators)
          .set({ presence: active ? 'online' : 'offline', updatedAt: now })
          .where(eq(operators.id, booking.operatorId));
      }

      return booking;
    });
  }
```

Extend that file's imports to include `and`, `operatorCheckins`, `operators`, and the domain types `ActorKind`/`BookingStatus`.

- [ ] **Step 4: Implement the service and routes**

`src/modules/bookings/dto/cancel-booking.dto.ts`:
```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const cancelBookingSchema = z.object({
  reason: z.string().max(500).optional(),
});

export class CancelBookingDto extends createZodDto(cancelBookingSchema) {}
```

Append to `BookingsService`:
```ts
  /**
   * Ownership first, then the pure machine, then persistence. The machine is
   * given the time rather than reading a clock, so this method is the only
   * place `Date.now()` enters a transition.
   */
  async act(
    bookingId: string,
    event: BookingEvent,
    actor: ActorKind,
    caller: AuthenticatedUser,
    reason?: string,
  ) {
    const booking = await this.repo.findById(bookingId);
    if (!booking) {
      throw new NotFoundError(ErrorCodes.BOOKING_NOT_FOUND, 'No such booking.');
    }

    const permitted =
      caller.role === 'admin' ||
      (caller.role === 'customer' && booking.customerId === caller.userId) ||
      (caller.role === 'operator' && booking.operatorId === caller.operatorId);
    if (!permitted) {
      throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'You are not a party to this booking.');
    }

    const result = transition(booking.status, event, actor, {
      now: new Date(),
      startAt: booking.startAt,
      lateCancellationMin: this.config.get('LATE_CANCELLATION_MIN', { infer: true }),
      bookingLeadTimeMin: this.config.get('BOOKING_LEAD_TIME_MIN', { infer: true }),
    });

    if (!result.ok) {
      throw new ConflictError(result.code, 'That action is not allowed in the current state.', {
        from: booking.status,
        event,
        actor,
      });
    }

    return this.repo.applyTransition(bookingId, result, actor, reason ?? null);
  }
```

Append to `BookingsController`:
```ts
  @Roles('customer')
  @Post(':id/ack')
  ack(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'CUSTOMER_ACK', 'customer', user);
  }

  @Roles('operator')
  @Post(':id/start')
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'START', 'operator', user);
  }

  @Roles('operator')
  @Post(':id/end')
  end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'END_SESSION', 'operator', user);
  }

  @Roles('customer', 'operator', 'admin')
  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.bookings.act(id, 'CANCEL', user.role as ActorKind, user, dto.reason);
  }

  @Roles('operator')
  @Post(':id/no-show')
  noShow(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'MARK_NO_SHOW', 'operator', user);
  }
```

- [ ] **Step 5: Extend the authorization matrix**

```ts
  { method: 'post', path: `/bookings/${uuidv7()}/ack`, allow: ['customer'] },
  { method: 'post', path: `/bookings/${uuidv7()}/start`, allow: ['operator'] },
  { method: 'post', path: `/bookings/${uuidv7()}/end`, allow: ['operator'] },
  { method: 'post', path: `/bookings/${uuidv7()}/cancel`, allow: ['customer', 'operator', 'admin'], body: {} },
  { method: 'post', path: `/bookings/${uuidv7()}/no-show`, allow: ['operator'] },
```

Note: these ids do not exist, so a permitted role reaches the handler and gets 404 — the matrix asserts only the 401/403 rows, which is exactly what it is for.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm test:integration`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: booking lifecycle endpoints with transactional presence maintenance"
```

---

## Task 26: Booking Reads, Access Guard & Expiry Sweep

**Files:**
- Create: `src/modules/bookings/booking-access.guard.ts`
- Create: `src/modules/maintenance/maintenance.repository.ts`, `src/modules/maintenance/maintenance.service.ts`, `src/modules/maintenance/maintenance.controller.ts`, `src/modules/maintenance/maintenance.module.ts`
- Modify: `src/modules/bookings/bookings.repository.ts`, `src/modules/bookings/bookings.controller.ts`, `src/app.module.ts`, `test/e2e/authz-matrix.spec.ts`
- Test: `test/e2e/booking-reads.spec.ts`, `test/e2e/expiry-sweep.spec.ts`

**Interfaces:**
- Consumes: `BookingsRepository` (24), `businessDayBounds` (18).
- Produces:
  - `BookingsRepository.listForCustomer(customerId: string): Promise<Booking[]>`, `listForOperator(operatorId: string): Promise<Booking[]>`
  - `BookingsService.listForCustomer(customerId)`, `listForOperator(operatorId)`, `getById(id): Promise<Booking>` — the last throws `NotFoundError` when absent
  - `BookingAccessGuard` — attaches the loaded booking to `request.booking` so the handler need not re-query
  - `MaintenanceService.sweepExpired(now?: Date): Promise<{ bookingsExpired: number; slotsExpired: number }>`
  - `GET /bookings`, `GET /bookings/:id`, `POST /admin/maintenance/sweep-expired`

- [ ] **Step 1: Write the failing reads test**

Create `test/e2e/booking-reads.spec.ts`, asserting:

```ts
  it('lists only the calling customer’s bookings', /* other customers absent */);
  it('lists only the calling operator’s assigned bookings', /* scoped by operator_id */);
  it('lets the booking’s customer read it', /* 200 */);
  it('lets the assigned operator read it', /* 200 */);
  it('lets an admin read any booking', /* 200 */);
  it('returns 403 to an unrelated customer — the IDOR case', /* 403, not 404 */);
  it('returns 403 to an unassigned operator', /* 403 */);
  it('returns 404 for a booking that does not exist', /* 404 */);
```

The unrelated-customer case is the one design §9 warns about most directly: it is easy to miss when testing only against your own data.

- [ ] **Step 2: Run to verify it fails, then implement the reads**

Run: `pnpm test:integration` → FAIL

Append to `src/modules/bookings/bookings.repository.ts`:
```ts
  listForCustomer(customerId: string): Promise<Booking[]> {
    return this.db
      .select()
      .from(bookings)
      .where(eq(bookings.customerId, customerId))
      .orderBy(desc(bookings.startAt));
  }

  listForOperator(operatorId: string): Promise<Booking[]> {
    return this.db
      .select()
      .from(bookings)
      .where(eq(bookings.operatorId, operatorId))
      .orderBy(desc(bookings.startAt));
  }
```

Add `desc` to the drizzle imports.

`src/modules/bookings/booking-access.guard.ts`:
```ts
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import { BookingsRepository } from './bookings.repository';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { Booking } from '../../infra/db/schema';

/**
 * Ownership as a declaration on the route, visible in code review — the answer
 * to Broken Object-Level Authorization. A booking is jointly held by a customer
 * and an operator, so neither can be expressed with a `me`-shaped URL; this
 * guard is what stands in for that.
 */
@Injectable()
export class BookingAccessGuard implements CanActivate {
  constructor(private readonly bookings: BookingsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      params: { id?: string };
      user?: AuthenticatedUser;
      booking?: Booking;
    }>();

    const id = request.params.id;
    const user = request.user;
    if (!id || !user) {
      throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'Missing booking or caller identity.');
    }

    const booking = await this.bookings.findById(id);
    if (!booking) {
      throw new NotFoundError(ErrorCodes.BOOKING_NOT_FOUND, 'No such booking.');
    }

    const permitted =
      user.role === 'admin' ||
      (user.role === 'customer' && booking.customerId === user.userId) ||
      (user.role === 'operator' && booking.operatorId === user.operatorId);

    if (!permitted) {
      throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'You are not a party to this booking.');
    }

    // Cached so the handler does not re-query.
    request.booking = booking;
    return true;
  }
}
```

Append to `BookingsController`:
```ts
  @Roles('customer', 'operator')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return user.role === 'operator'
      ? this.bookings.listForOperator(requireOperatorId(user))
      : this.bookings.listForCustomer(user.userId);
  }

  @Roles('customer', 'operator', 'admin')
  @UseGuards(BookingAccessGuard)
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.getById(id);
  }
```

Add the corresponding `listForCustomer`, `listForOperator`, and `getById` passthroughs to `BookingsService`, where `getById` throws `NotFoundError` when absent. Register `BookingAccessGuard` in `BookingsModule` providers.

- [ ] **Step 3: Write the failing expiry-sweep test**

Create `test/e2e/expiry-sweep.spec.ts`, asserting:

```ts
  it('expires a confirmed booking whose tick has passed', /* status 'expired' */);
  it('expires a customer_ready booking whose tick has passed', /* status 'expired' */);
  it('leaves an in_progress booking alone — the session is running late, not dead', /* unchanged */);
  it('leaves a future booking alone', /* unchanged */);
  it('does not touch already-completed or cancelled bookings', /* unchanged */);
  it('expires open slots whose tick has passed', /* slot status 'expired' */);
  it('leaves booked past slots alone — their booking owns that decision', /* unchanged */);
  it('is idempotent — a second sweep changes nothing', /* same counts, zero on rerun */);
  it('rejects a non-admin with 403', /* 403 */);
```

- [ ] **Step 4: Implement the sweep**

`src/modules/maintenance/maintenance.repository.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, inArray, lt } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { bookings, operatorSlots } from '../../infra/db/schema';

@Injectable()
export class MaintenanceRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The logic sub-project #3 will schedule. It lives here, fully tested, so
   * that task only has to add a BullMQ trigger.
   *
   * in_progress bookings are deliberately excluded: a session running past its
   * tick is late, not abandoned, and only END_SESSION should close it.
   */
  async sweepExpired(now: Date): Promise<{ bookingsExpired: number; slotsExpired: number }> {
    return this.db.transaction(async (tx) => {
      const expiredBookings = await tx
        .update(bookings)
        .set({ status: 'expired', cancelledBy: 'system', cancelledAt: now, updatedAt: now })
        .where(
          and(
            lt(bookings.startAt, now),
            inArray(bookings.status, ['confirmed', 'customer_ready']),
          ),
        )
        .returning({ id: bookings.id });

      const expiredSlots = await tx
        .update(operatorSlots)
        .set({ status: 'expired', updatedAt: now })
        .where(and(lt(operatorSlots.startAt, now), inArray(operatorSlots.status, ['open'])))
        .returning({ id: operatorSlots.id });

      return { bookingsExpired: expiredBookings.length, slotsExpired: expiredSlots.length };
    });
  }
}
```

`src/modules/maintenance/maintenance.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { MaintenanceRepository } from './maintenance.repository';

@Injectable()
export class MaintenanceService {
  constructor(private readonly repo: MaintenanceRepository) {}

  sweepExpired(now = new Date()) {
    return this.repo.sweepExpired(now);
  }
}
```

`src/modules/maintenance/maintenance.controller.ts`:
```ts
import { Controller, Post } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { MaintenanceService } from './maintenance.service';

@Roles('admin')
@Controller('admin/maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  // Admin-triggerable now; sub-project #3 schedules the same service method.
  @Post('sweep-expired')
  sweep() {
    return this.maintenance.sweepExpired();
  }
}
```

`src/modules/maintenance/maintenance.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceRepository } from './maintenance.repository';
import { MaintenanceService } from './maintenance.service';

@Module({
  controllers: [MaintenanceController],
  providers: [MaintenanceRepository, MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
```

Add `MaintenanceModule` to `src/app.module.ts`.

- [ ] **Step 5: Complete the authorization matrix**

Add the final rows to `PROTECTED_ROUTES`:
```ts
  { method: 'get', path: '/bookings', allow: ['customer', 'operator'] },
  { method: 'get', path: `/bookings/${uuidv7()}`, allow: ['customer', 'operator', 'admin'] },
  { method: 'post', path: '/admin/maintenance/sweep-expired', allow: ['admin'] },
```

Then verify the table is complete: every route in spec §5.7 must appear in `PROTECTED_ROUTES` unless it is `@Public()` (`/auth/*` except `logout-all`, `/discovery/*`, `/health*`). Grep the controllers for `@Get`, `@Post`, and `@Patch` and account for every one.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm build`
Expected: all green

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: booking reads with access guard, admin-triggerable expiry sweep"
```

---

## Phase 2 Completion Checklist

- [ ] `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build` all pass.
- [ ] **The concurrency test genuinely proves the design:** 12 simultaneous attempts at a capacity-2 slot yield exactly 2 bookings, 10 rejections, and 2 distinct operators. If it ever passes with more than 2 winners, `FOR UPDATE SKIP LOCKED` has been lost.
- [ ] The state-machine test asserts the full cartesian product — 7 statuses × 6 events × 4 actors = 168 cells, 14 allowed and 154 rejected.
- [ ] `PROTECTED_ROUTES` covers every non-`@Public()` route across both phases.
- [ ] Every localized field returns an object carrying all of `SUPPORTED_LOCALES`, never a pre-resolved string.
- [ ] `operators.presence` is never read by discovery — grep the discovery module for `presence` and confirm zero hits.
- [ ] Every migration in `drizzle/` is committed, and a fresh `pnpm migrate` against an empty database succeeds.
- [ ] The five policies from spec §5.6 each have a passing test: cancellation release, late-cancellation stamping, no-show, expiry, and `START` permitted from `confirmed`.

## Verified end-to-end walkthrough

Run once by hand against a fresh database before declaring the phase done. Each step exercises a different subsystem, and the sequence is the product's core loop:

1. `pnpm seed:admin admin@acs.local 'a-long-admin-password' 'Admin'`
2. `POST /auth/login` as that admin → access token.
3. `POST /admin/locations` → a location at known coordinates with `en` and `he` names.
4. `POST /admin/locations/:id/session-types` → two session types at different prices.
5. `POST /admin/operators` → capture the `setupToken`; `POST /auth/setup/:token`; `POST /admin/operators/:id/approve`.
6. `POST /auth/login` as the operator; `POST /operators/me/checkins` for a window later today at the location's coordinates.
7. `POST /auth/otp/request` then `/auth/otp/verify` as a customer (fake provider code in dev).
8. `GET /discovery/locations?lat=&lng=` → the location appears with a minimum price and slot capacities.
9. `POST /bookings` → a `confirmed` booking with a `priceSnapshot`.
10. `POST /bookings/:id/ack`, then `/start`, then `/end` → `completed`, with `sessionEndAt` stamped and the operator's presence back to `online`.

Sub-project #4 keys drone-video matching off that `sessionEndAt`, so confirm it is populated before moving on.
