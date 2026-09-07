# ACS Backend — Foundation, Auth & Core Booking Loop

**Status:** approved design
**Date:** 2026-09-02
**Source:** `photographer-app-design.md` (product design). Throughout this spec, that document's `photographer` is renamed **`operator`** — the app serves drone operators shooting customer videos.

---

## 1. Scope

The product design describes roughly seven backend subsystems. Building them under one spec would produce an unreviewable implementation plan, so the backend is decomposed into five sequenced sub-projects:

| # | Sub-project | Contents |
|---|---|---|
| **1** | **Foundation + Auth** | Project scaffold, config, Postgres + PostGIS, migrations, error model, logging, test harness, users/roles, customer OTP, operator + admin password login, JWT + revocable refresh tokens |
| **2** | **Core booking loop** | Locations, session types, operator check-in, slot inventory, geo discovery, bookings + state machine |
| 3 | Sessions + jobs | BullMQ, slot expiry, readiness reminders, push notifications |
| 4 | Media pipeline | Presigned uploads, content-hash dedupe, ffmpeg trim + watermark worker, preview and full-res delivery, **identity photo (capture + access audit + purge)** |
| 5 | Payments | Israeli gateway integration, purchases, webhook validation, full-res entitlement |

**This spec covers sub-projects #1 and #2.** They are specified together because #1 alone is plumbing that proves nothing, while #2 is the technical heart of the product.

### 1.1 Explicitly out of scope

- Job queue and scheduling (#3). Expiry and no-show logic is implemented and tested here, but invoked by an admin-triggerable command rather than a scheduler.
- Media upload, ffmpeg processing, and delivery (#4).
- **Identity photo (design §3.4).** Deferred wholesale to #4. Design §6 requires the purge job be treated as core to the feature rather than a follow-up; capture depends on S3 presigning (#4) and purge depends on the scheduler (#3), so shipping capture here would mean collecting biometric-adjacent data with no deletion path. It ships as one complete unit in #4.
- Payments (#5). Design §7 establishes that Stripe does not support Israeli entities; gateway selection happens in #5.
- Realtime sockets. Design §4 accepts 5–10s polling for MVP.
- Ratings and operator vetting workflow beyond admin approve/suspend (design §5 cuts these).
- Redis caching of the discovery query (design §3.2 defers it).

---

## 2. Architecture

### 2.1 Deployable shape

A single NestJS process. Sub-project #3 adds a second entrypoint (`src/worker.ts`) that boots the same Nest modules with the HTTP layer disabled, so API and worker share `infra/` and domain services while scaling and failing independently. Structuring for this now is free; retrofitting it later is a refactor.

### 2.2 Stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript strict (`strict`, `noUncheckedIndexedAccess`) | |
| Framework | NestJS 11 | Module system fits six domains; guards make role and ownership checks declarative, satisfying design §9's requirement that authorization be middleware rather than per-route copy-paste |
| Package manager | pnpm | |
| Database | Postgres 16 + PostGIS 3.4 | Geo query is core to the product (design §2) |
| Data access | Drizzle ORM + drizzle-kit | Schema-as-code with generated SQL migrations, real custom-type support for `geography(Point)`, and a typed `` sql`` `` escape hatch so `ST_DWithin` and the slot-locking query stay first-class. Prisma treats PostGIS as `Unsupported()`, forcing the two most important queries in the app into untyped raw SQL |
| Cache / rate limiter | Redis 7 | Login and OTP rate limiting (design §8, §9) |
| Validation | zod + `nestjs-zod` | Pairs with `drizzle-zod` so DTOs derive from the database schema instead of drifting from it. A deliberate departure from Nest's `class-validator` default |
| Config | `@nestjs/config` + zod-validated env schema | Fails at boot on a missing or invalid variable |
| Logging | pino via `nestjs-pino` | Structured JSON with request-id correlation |
| Tests | Vitest | Faster TDD inner loop than Jest |
| API docs | `@nestjs/swagger` → OpenAPI | Gives the React Native clients a real contract |
| SMS delivery | SMS4Free behind an `SmsProvider` port, selected by config | Cheaper and more agile than a managed verification service. The port is a single `send(phone, message)` method, so swapping SMS4Free → InforU → anything is one factory change (§4.5) |
| OTP protocol | Owned in-house (`OtpService`) | The consequence of a dumb SMS pipe: code generation, hashing, expiry, attempt counting, and abuse protection are ours, not a vendor's (§4.5) |

### 2.3 Code organization

Classic layered Nest modules — controller → service → repository, one module per domain — with one deliberate exception: the booking state machine is pure, framework-free TypeScript.

```
docker-compose.yml            postgis + redis
drizzle/                      generated migrations (committed)
src/
  main.ts                     API entrypoint (worker.ts arrives in #3)
  common/                     guards · exception filter · domain errors · decorators
  infra/
    config/                   zod env schema
    db/                       drizzle client, schema, migration runner
    redis/
  modules/
    auth/                     login, OTP protocol, tokens, refresh rotation
    sms/                      SmsProvider port + SMS4Free and fake adapters
    users/                    identity, roles
    operators/                profile, admin invite / approve / suspend
    locations/                admin CRUD for locations + session types
    presence/                 check-in, check-out, slot materialization
    slots/                    slot inventory queries
    discovery/                the geo query
    bookings/
      domain/                 pure state machine — no Nest, no DB, no I/O
      bookings.controller.ts
      bookings.service.ts
      bookings.repository.ts
test/
  integration/                real Postgres, truncate between tests
```

Full hexagonal ports-and-adapters was rejected: for six domains it produces interfaces with exactly one implementor each. An internal event bus was rejected for now — it earns its keep in #3 when the job queue gives it a reason, and until then it makes flows harder to trace.

### 2.4 Cross-cutting conventions

**Time.** Every timestamp is `timestamptz` stored in UTC. A single configured business timezone (`Asia/Jerusalem`) lives in config and is the *only* place "today" is computed. The design's "today only" slots (§5), the daily operator-load calculation, and slot expiry all depend on it; scattered `new Date()` calls guarantee an off-by-one at midnight.

**Identifiers.** UUIDv7 primary keys, generated in the application. Non-sequential, so design §9's "unguessable object keys" requirement holds for storage keys derived from them in #4, but time-ordered, so they index well — unlike UUIDv4.

**Money.** `numeric(10,2)` with an explicit ISO-4217 `currency` column, defaulting to `ILS`. Never floating point.

**Localization.** The system serves English and Hebrew. **Right-to-left is entirely a client concern** — the API emits no layout, so text direction, mirroring, and bidi rendering require nothing from the backend. Date, number, and currency formatting are likewise client-side; the backend emits ISO-8601 UTC timestamps and a `numeric` plus an explicit `currency` code.

The backend's responsibility is narrower, and has two halves:

1. **Text the backend originates**, which the client cannot localize after the fact — OTP SMS, the operator invite email, and later push notifications (#3). These are addressed by `users.preferred_locale` (§3.4).
2. **Admin-authored display strings** stored in the database — location and session-type names and descriptions. These use a shared **`LocalizedText`** shape: a `jsonb` object keyed by locale, with a CHECK enforcing that every supported locale is present.

```
name jsonb NOT NULL CHECK (jsonb_exists(name,'en') AND jsonb_exists(name,'he'))
-- {"en": "Beginner Slope", "he": "מסלול מתחילים"}
```

Use `jsonb_exists(col, 'en')` rather than the `col ? 'en'` operator: node-postgres parses `?` as a parameter placeholder, and the operator form will fail at runtime even though it is valid SQL.

Adding a locale is then a data migration rather than a schema one — relevant given Arabic and Russian are plausible for a tourist-facing service in Israel.

**Identity is separated from display.** Because display strings are now localized objects, they can no longer serve as keys. Every admin-curated entity carries a stable, never-localized `code` (a slug) that owns uniqueness, grouping, and client-side keying of icons and analytics.

**Responses carry every locale**, rather than negotiating one via `Accept-Language`. The catalog is a handful of locations and session types, so the extra bytes are negligible, and switching language in-app refetches nothing.

---

## 3. Data model

Postgres extension required: `postgis`.

### 3.1 Corrections to the product design's schema

1. **`photographers.status` conflated two orthogonal axes.** Design §2 uses it for `offline/online/in_session`; §8 uses it for `approved`. A suspended operator can still be "online." Split into `operators.approval_status` (lifecycle) and `operators.presence` (live state).
2. **The `pending` booking status is dropped.** Design §2 says "pending/confirmed" without resolving it. With identity photo deferred and payment occurring after the session, there is nothing to be pending on. Bookings are created `confirmed`. Reintroducing `pending` when identity photo lands in #4 is a migration, not a redesign.
3. **`rating` and `stripe_account_id` are dropped.** Design §5 cuts ratings from MVP; §7 establishes Stripe is unusable for Israeli entities.
4. **`operators.price_per_session` is dropped.** Pricing is a property of (location, session type) and is explicitly operator-independent.
5. **`photographer_locations` is replaced by `operator_checkins`.** Presence means "checked in at location L for a window," not a free-floating lat/lng. Reported coordinates are retained only to verify the operator is physically at the location.
6. **`availability_slots` is replaced by `operator_slots`.** Slots are no longer operator-authored; they are materialized against a fixed platform-wide 15-minute grid. See §3.3.
7. **No exclusion constraint is needed.** An earlier draft added a `tstzrange` exclusion constraint to prevent operators publishing overlapping slots. A fixed grid plus `UNIQUE (operator_id, start_at)` makes overlap unrepresentable, so the grid does that work for free.

### 3.2 Inventory model

Locations are admin-curated. Each location offers its own free-form session types, each with a price. **All sessions are 15 minutes** — session type varies price and style, not duration. Session-type vocabularies are per-location and share nothing across locations (Location A may offer `extreme`/`mild` while Location B offers `slow`/`fast`).

The slot grid is global and fixed at `:00 :15 :30 :45`. Operators check in to a location for a window and can run any session type offered there. **Capacity is the number of operators checked in**: two operators at Location A means the 10:00 slot there has capacity 2.

A customer books *(location, slot time, session type)*; the system assigns the operator.

### 3.3 Why inventory is materialized into rows

Because "the 10:00 slot at Location A" is a *count* rather than a row, the product design's double-booking guard — `UPDATE availability_slots SET status='booked' WHERE id=? AND status='open'` — no longer applies. Guarding a count under concurrency is substantially harder to get right than guarding a row.

Therefore check-in generates one `operator_slots` row per grid tick in the declared window, restoring row-level inventory. Booking then becomes a single statement that atomically selects *and* fairly assigns:

```sql
-- inside one transaction, READ COMMITTED
SELECT s.id, s.operator_id
FROM operator_slots s
LEFT JOIN LATERAL (
  SELECT count(*) AS n
  FROM bookings b
  WHERE b.operator_id = s.operator_id
    AND b.start_at >= :day_start AND b.start_at < :day_end
    AND b.status <> 'cancelled'
) load ON true
WHERE s.location_id = :location_id
  AND s.start_at    = :start_at
  AND s.status      = 'open'
ORDER BY load.n ASC, random()
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

This buys four properties at once:

- Capacity is enforced by row existence, not by counting.
- `SKIP LOCKED` makes concurrent bookings fall through to the next-best operator instead of colliding or serializing.
- The fairness rule is an `ORDER BY`: fewest bookings today, `random()` on ties. **"Work so far that day" means all bookings assigned for today, including upcoming ones** — counting only completed sessions would route every advance booking to the same operator, since all operators sit at zero.
- `UNIQUE (operator_id, start_at)` makes "one operator, two sessions at 10:00" impossible at the database level.

Zero rows returned means the slot is no longer available, matching the design's intended behavior.

### 3.4 Tables

```sql
CREATE TYPE user_role         AS ENUM ('customer','operator','admin');
CREATE TYPE user_status       AS ENUM ('operator_pending_setup','active','suspended');
CREATE TYPE operator_approval AS ENUM ('pending','approved','rejected','suspended');
CREATE TYPE operator_presence AS ENUM ('offline','online','in_session');
CREATE TYPE checkin_status    AS ENUM ('active','ended');
CREATE TYPE slot_status       AS ENUM ('open','booked','cancelled','expired');
CREATE TYPE booking_status    AS ENUM ('confirmed','customer_ready','in_progress',
                                       'completed','cancelled','no_show','expired');
CREATE TYPE actor_kind        AS ENUM ('customer','operator','admin','system');
```

**`users`** — identity root for all three roles.

```sql
users (
  id                uuid PRIMARY KEY,
  role              user_role   NOT NULL,
  phone             text UNIQUE,              -- E.164, customers only
  email             text UNIQUE,              -- lowercased; operators/admins, login identifier
  password_hash     text,                     -- argon2id; operators/admins only
  display_name      text,                     -- nullable: OTP signup supplies no name
  status            user_status NOT NULL DEFAULT 'active',
  preferred_locale  text NOT NULL DEFAULT 'he',   -- validated against SUPPORTED_LOCALES
  phone_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_identity CHECK (
    role <> 'customer' OR (phone IS NOT NULL AND email IS NULL AND password_hash IS NULL)),
  CONSTRAINT staff_identity CHECK (
    role =  'customer' OR (email IS NOT NULL AND phone IS NULL))
)
```

Email is the operator login identifier. Design §8 says "username + password" but also specifies a one-time setup link, which requires a delivery channel; email serves both roles. Emails are lowercased and trimmed in the application before storage or lookup.

`display_name` is nullable because a customer authenticating by OTP supplies no name; the client prompts for one after first login. Operator and admin rows always have it set at creation.

**`staff_identity` forbids `phone` on operator and admin rows deliberately.** `users.phone` is the customer OTP login identifier, so an operator with a phone on their row could authenticate by SMS and bypass password auth entirely — silently defeating the invite-only, approval-gated operator flow. If operators need a contact number, it belongs on `operators` as a non-credential field, which is an additive migration.

**`operators`** — profile, 1:1 with a user.

```sql
operators (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL UNIQUE REFERENCES users(id),
  display_name    text NOT NULL,
  bio             text,
  gear_tags       text[] NOT NULL DEFAULT '{}',
  approval_status operator_approval NOT NULL DEFAULT 'pending',
  approved_at     timestamptz,
  approved_by     uuid REFERENCES users(id),
  presence        operator_presence NOT NULL DEFAULT 'offline',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
)
```

**`locations`** — admin-curated sites.

```sql
locations (
  id          uuid PRIMARY KEY,
  code        text NOT NULL UNIQUE,               -- stable slug, never localized
  site_code   text NOT NULL,                      -- grouping key, never localized
  site_name   jsonb NOT NULL,                     -- LocalizedText
  name        jsonb NOT NULL,                     -- LocalizedText
  description jsonb,                              -- LocalizedText, nullable
  geog        geography(Point,4326) NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_exists(site_name,'en') AND jsonb_exists(site_name,'he')),
  CHECK (jsonb_exists(name,'en')      AND jsonb_exists(name,'he'))
)
CREATE INDEX locations_geog_idx ON locations USING GIST (geog);
CREATE INDEX locations_site_idx ON locations (site_code);
```

`code` replaces the previous `UNIQUE (site, name)`. Human-readable names are now `LocalizedText` objects and cannot serve as identity keys, so a stable slug owns uniqueness instead — a stricter guarantee, since it is global rather than per-site.

The site is a pair of plain fields, not a separate entity: `site_code` groups and indexes, `site_name` displays. Nothing in scope needs site-level attributes — discovery is geo, check-in is per-location, pricing is per-location. Note that `site_name` is denormalized across every location at a site, so localizing it makes promoting site to its own table somewhat more attractive than before; it remains a clean additive migration whenever site-level branding or reporting arrives.

**`location_session_types`** — per-location offering and price.

```sql
location_session_types (
  id          uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES locations(id),
  code        text NOT NULL,                      -- 'extreme', 'mild' — never localized
  name        jsonb NOT NULL,                     -- LocalizedText
  description jsonb,                              -- LocalizedText, nullable
  price       numeric(10,2) NOT NULL CHECK (price >= 0),
  currency    char(3) NOT NULL DEFAULT 'ILS',
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, code),
  CHECK (jsonb_exists(name,'en') AND jsonb_exists(name,'he'))
)
```

Session-type vocabularies remain per-location (§3.2); `code` is unique only within its location, so Location A's `extreme` and Location B's `extreme` are unrelated rows that may carry different names and prices.

**`operator_checkins`** — operator present at a location for a window.

```sql
operator_checkins (
  id               uuid PRIMARY KEY,
  operator_id      uuid NOT NULL REFERENCES operators(id),
  location_id      uuid NOT NULL REFERENCES locations(id),
  available_from   timestamptz NOT NULL,
  available_until  timestamptz NOT NULL,
  checked_in_geog  geography(Point,4326) NOT NULL,   -- reported position, retained for audit
  status           checkin_status NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  CHECK (available_until > available_from)
)
CREATE INDEX operator_checkins_operator_idx ON operator_checkins (operator_id, status);
CREATE INDEX operator_checkins_location_idx ON operator_checkins (location_id, available_from);
```

**`operator_slots`** — materialized 15-minute inventory.

```sql
operator_slots (
  id          uuid PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES operators(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  checkin_id  uuid NOT NULL REFERENCES operator_checkins(id),
  start_at    timestamptz NOT NULL,
  status      slot_status NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grid_aligned CHECK (
    EXTRACT(minute      FROM start_at AT TIME ZONE 'UTC') IN (0,15,30,45)
    AND EXTRACT(second  FROM start_at AT TIME ZONE 'UTC') = 0)
)
CREATE UNIQUE INDEX one_session_per_operator_per_tick
  ON operator_slots (operator_id, start_at) WHERE status <> 'cancelled';
CREATE INDEX operator_slots_lookup_idx
  ON operator_slots (location_id, start_at, status);
```

The uniqueness constraint is **partial** (`status <> 'cancelled'`) so that an operator who checks out and later checks in again for the same window can have those slots regenerated. A non-partial constraint would permanently poison those ticks. `AT TIME ZONE 'UTC'` in the check constraint keeps the expression immutable and correct regardless of session timezone.

**`bookings`** — one per operator slot.

```sql
bookings (
  id                       uuid PRIMARY KEY,
  operator_slot_id         uuid NOT NULL UNIQUE REFERENCES operator_slots(id),
  customer_id              uuid NOT NULL REFERENCES users(id),
  operator_id              uuid NOT NULL REFERENCES operators(id),
  location_id              uuid NOT NULL REFERENCES locations(id),
  location_session_type_id uuid NOT NULL REFERENCES location_session_types(id),
  price_snapshot           numeric(10,2) NOT NULL,
  currency                 char(3) NOT NULL,
  start_at                 timestamptz NOT NULL,
  status                   booking_status NOT NULL DEFAULT 'confirmed',
  late_cancellation        boolean NOT NULL DEFAULT false,
  cancelled_by             actor_kind,
  cancellation_reason      text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  ready_ack_at             timestamptz,
  started_at               timestamptz,
  session_end_at           timestamptz,
  completed_at             timestamptz,
  cancelled_at             timestamptz
)
CREATE INDEX bookings_customer_idx ON bookings (customer_id, start_at DESC);
CREATE INDEX bookings_operator_idx ON bookings (operator_id, start_at);
CREATE UNIQUE INDEX customer_one_booking_per_tick
  ON bookings (customer_id, start_at)
  WHERE status IN ('confirmed','customer_ready','in_progress');
```

Three constraints here are load-bearing:

- **`operator_slot_id UNIQUE`** is the belt to the `SKIP LOCKED` braces. Even if the optimistic selection were ever wrong, the database refuses the second booking.
- **`customer_one_booking_per_tick`** prevents a customer booking themselves into two locations at 10:00. The operator-side constraint does not cover the customer side, and at a ski site with adjacent locations this is an easy accidental double-book.
- **`price_snapshot`** and `currency` are copied at booking time. Without them, an admin editing a location's price retroactively changes what already-booked customers owe.

**`refresh_tokens`** — revocable sessions (design §8).

```sql
refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,        -- SHA-256 hex of an opaque 256-bit token
  device_info text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id)
)
CREATE INDEX refresh_tokens_user_idx   ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
```

**`setup_tokens`** — admin-issued operator invites (design §8).

```sql
setup_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
)
```

---

## 4. Authentication and authorization

### 4.1 Login paths

| Role | Identity | Endpoints |
|---|---|---|
| Customer | Phone + OTP | `POST /auth/otp/request` → `OtpService` generates and sends via `SmsProvider`; `POST /auth/otp/verify` → verifies, upserts user, issues tokens (§4.5) |
| Operator | Email + password, invite-only | Admin creates the user (`status='operator_pending_setup'`) → one-time link → `POST /auth/setup/:token` sets the password → `POST /auth/login` |
| Admin | Email + password | Provisioned by CLI seed only, never a signup route; same `POST /auth/login` |

**Both flows send text the client cannot localize**, so both are locale-aware (§2.4). `POST /auth/otp/request` accepts a `locale`, which selects the SMS message template and is persisted to `users.preferred_locale` on verification. The operator invite email is rendered in the locale the admin sets when creating the account, defaulting to `DEFAULT_LOCALE`. Without this, a Hebrew-speaking operator receives an English invite.

Message templates live in code, not the database — they are developer-owned strings, not admin-authored content. **The Hebrew template must stay within 70 characters.** Hebrew SMS is encoded as UCS-2, which fits 70 characters per segment rather than GSM-7's 160, so an over-long template silently bills two segments for every code sent. A unit test asserts the length.

Phone numbers are normalized to E.164 (libphonenumber) before any storage or lookup. Skipping normalization does not merely create duplicate users — it defeats per-phone OTP rate limiting, because `0501234567` and `+972501234567` would count as different numbers.

Passwords are hashed with **argon2id** at OWASP parameters: m=19 MiB, t=2, p=1.

#### Operator invite lifecycle

`user_status = 'operator_pending_setup'` is the invite waiting room: the account row exists, but no password has been set. Design §8 requires operators be provisioned by admin-issued invite rather than self-registration, so there is necessarily a window where the user record is real but unusable, and that window needs a name. The status is operator-only — customers are created `active` by OTP verify (there is no password to set), and admins are CLI-seeded with a password directly.

| Step | Action | Result |
|---|---|---|
| 1 | Admin `POST /admin/operators` | `users`: `role='operator'`, `status='operator_pending_setup'`, `password_hash` NULL · `operators`: `approval_status='pending'` · `setup_tokens` row created, one-time link emailed |
| 2 | Operator `POST /auth/setup/:token` | Token validated (unused, unexpired) → `password_hash` set → `status='active'` → `setup_tokens.used_at` stamped |
| 3 | Admin `POST /admin/operators/:id/approve` | `operators.approval_status='approved'` |

It is a status value rather than an inference from `password_hash IS NULL` because §4.2 step 2 re-checks `users.status = 'active'` on every refresh. One authoritative field means that single check covers all three reasons an identity cannot authenticate — never set up, suspended, deactivated — instead of the login path testing password nullability while the refresh path tests status, which is how those two drift apart. It also keeps *never activated* distinct from *suspended*, which call for different admin actions (resend invite vs. reinstate), and makes the invite backlog queryable.

**`users.status` and `operators.approval_status` are two independent gates.** The first answers "can this identity authenticate?", the second "is this operator cleared to work?" An operator can legitimately be `active` + `pending`: they log in and complete their profile while §5.1's check-in guard keeps rejecting them until an admin approves. That combination is intended, not an edge case.

### 4.2 Tokens

**Access token:** HS256 JWT, 15-minute expiry, carrying `sub`, `role`, `operator_id` where relevant, and `jti`.

**Refresh token:** *not* a JWT. 256 bits of opaque random, stored only as a SHA-256 hash, valid 30 days, and rotated on every use.

`POST /auth/refresh` performs three steps, in this order:

1. Look up the presented token's hash. If the row has `revoked_at` or `replaced_by` set, this is a **replayed token** — design §9's theft signal. Revoke the entire `family_id`, not just that row, and return 401.
2. Re-check `users.status = 'active'`, and for operators `operators.approval_status = 'approved'`. **This step is what actually enforces "approved operators only" on an ongoing basis** — design §8's central point. Checking only at login lets a suspended operator refresh indefinitely.
3. Issue a new access/refresh pair and set `replaced_by` on the old row.

`POST /auth/logout` revokes the presented token. `POST /auth/logout-all` revokes every token for the user.

No token blocklist. Design §8 explicitly accepts up to 15 minutes of staleness on a suspended user's access token in exchange for not operating revocation infrastructure.

### 4.3 Authorization

`JwtAuthGuard` is registered **globally**, with `@Public()` as the explicit opt-out. The direction is deliberate: a newly added endpoint is protected because someone had to choose to expose it. Opt-in protection fails open the first time someone forgets.

Layered on top:

- `@Roles('operator')` etc. via `RolesGuard`.
- Per-resource access guards. `BookingAccessGuard` asserts the requester is the booking's customer, its assigned operator, or an admin. Ownership is therefore a declaration visible in the route and in code review — design §9's answer to Broken Object-Level Authorization.

401 (not authenticated) and 403 (authenticated, wrong role or not the owner) stay distinct, per design §8.

### 4.4 Abuse protection

Redis-backed rate limits on: OTP request (per phone **and** per IP, plus a per-phone daily cap), OTP verify attempts (per code, with lockout), and login attempts (per email **and** per IP, with lockout). Plus `helmet`.

**These limiters are now the only defense against SMS bombing.** An earlier draft delegated that to a managed verification service's built-in abuse protection; with a plain SMS gateway (§4.5) it is entirely ours. The per-phone daily cap is therefore cost control as much as abuse control — every send is billed, and an unbounded resend loop is a billing incident before it is a security one.

**`trust proxy` must be configured correctly.** Behind a TLS-terminating host, an unconfigured proxy makes every request appear to originate from the load balancer, silently collapsing every per-IP limit into a single global limit.

### 4.5 SMS delivery and the OTP protocol

The SMS vendor is a dumb pipe, so two concerns that a managed verification service would have bundled are separated here.

**`SmsProvider` — the swappable transport.**

```ts
interface SmsProvider {
  send(phone: string, message: string): Promise<void>;   // throws SmsDeliveryError
}
```

One method, no knowledge of OTP. `SMS_PROVIDER` (config) names the implementation, and a factory resolves it, so adding InforU or returning to a managed service is a new class plus a config value — nothing outside that factory changes. `Sms4FreeProvider` posts JSON to SMS4Free's HTTP endpoint and maps its numeric status to a thrown domain error; vendor status codes never escape the adapter. `FakeSmsProvider` captures messages in memory for tests.

**Non-Israeli numbers are rejected at request time.** SMS4Free is an Israeli gateway, and delivery to foreign numbers is not assumed to work. Rather than report "code sent" for a message that never arrives — the worst failure mode, and near-undiagnosable from support tickets — `POST /auth/otp/request` returns **`PHONE_COUNTRY_UNSUPPORTED`** for any number outside `SMS_SUPPORTED_COUNTRIES` (default `IL`). Country-based provider routing is deferred (§11); the port already accommodates it.

**`OtpService` — the protocol, owned in-house.**

Request:
1. Normalize to E.164 (§4.1). Every Redis key derives from the normalized value, or the cooldown, daily cap, and attempt counter are all trivially bypassable.
2. Enforce the cooldown and daily cap.
3. Generate a 6-digit code from a CSPRNG over the **full** `000000`–`999999` range, zero-padded. Restricting to `100000`–`999999` would discard 10% of the keyspace for no reason.
4. Store **`HMAC-SHA256(code, OTP_SECRET)`** — not the code, and deliberately not a password hash. A 6-digit code's security comes from its 5-minute TTL and 5-attempt cap, not from hash cost; a memory-hard hash would add ~50 ms and ~19 MiB per verify, which is a denial-of-service amplifier an attacker triggers for free. The keyed HMAC still prevents offline brute force of a leaked Redis dump, because 10⁶ candidates are useless without the secret.
5. Render the localized template and hand it to `SmsProvider`.

Storage is a Redis **hash**, and the shape matters:

```
HSET   otp:{e164} hash <hex>     # once, at creation
EXPIRE otp:{e164} OTP_TTL_SEC    # once, at creation — never re-armed
HINCRBY otp:{e164} attempts 1    # per verify; does not touch the TTL
```

Two bugs are designed out by that structure. Re-arming the TTL on a failed attempt would let an attacker hold a code alive indefinitely by guessing wrong, converting a 5-attempt cap into an unlimited one. And reading `attempts`, adding one, and writing it back is a race — two concurrent verifies both read `4`, both write `5`, and the cap leaks extra tries. `HINCRBY` is atomic and leaves the expiry alone.

Verify **increments before comparing**, so a timeout or crash mid-request cannot yield a free attempt. Over the cap: delete the key and reject. Comparison is constant-time. On success the key is deleted immediately — codes are single-use.

`OTP_SECRET` is a distinct secret from `JWT_SECRET`. Sharing one would mean a leak in either subsystem compromised both.

---

## 5. Key flows

### 5.1 Operator check-in

`POST /operators/me/checkins` with `{ location_id, available_from, available_until, lat, lng }`.

Guards: the operator's `approval_status` is `approved`; the location is active; `available_from` and `available_until` are both grid-aligned with `available_until > available_from`; the window falls **within a single business day** in `BUSINESS_TIMEZONE` (design §5 scopes slots to "today only," and a window crossing midnight would produce slots that discovery's today-filter silently hides); and `ST_DWithin(locations.geog, reported_point, CHECKIN_LOCATION_TOLERANCE_M)` confirms the operator is physically at the location.

In one transaction: insert the `operator_checkins` row, then generate one `operator_slots` row per 15-minute tick in `[available_from, available_until)`.

Slot generation inserts with `ON CONFLICT (operator_id, start_at) WHERE status <> 'cancelled' DO NOTHING`, then compares rows inserted against ticks expected. A mismatch means this operator is already committed at those times, possibly at another location, so the request fails with **409 and the list of conflicting ticks** rather than silently producing a partial check-in.

On success, `operators.presence` becomes `online`.

### 5.2 Operator check-out

`POST /operators/me/checkins/:id/end` sets the check-in to `ended` and cancels only its `open` slots.

**Booked slots survive.** Going offline does not dissolve a commitment to a customer who has already booked. `presence` flips to `offline`; the obligation stands. Releasing a booked slot requires cancelling the booking explicitly (§5.5), which is a separate, auditable act.

### 5.2a Operator schedule

`GET /operators/me/schedule?date=` returns the calling operator's own day: their active check-in windows, and every slot in them with its status — plus, for booked slots, the booking's id, status, `start_at`, the session type's `code` and `LocalizedText` name, and the customer's display name and phone. This is the operator app's home screen. It is scoped to `operator_id` from the access token, never a path parameter, so there is no object-level authorization surface to get wrong.

### 5.2b Mid-day break

`POST /operators/me/breaks { from, to }` withdraws availability for part of an already-active window, so an operator can take a break without ending their check-in.

Availability is entirely a function of which `operator_slots` rows exist and are `open` — discovery (§5.3) reads slot rows and never consults `operators.presence` — so a break needs no new state. It cancels the affected rows:

```sql
UPDATE operator_slots SET status = 'cancelled'
WHERE operator_id = :operator_id
  AND status     = 'open'
  AND start_at  >= :from
  AND start_at   < :to
```

Guards: `from` and `to` are grid-aligned with `to > from`, and the range lies inside one of the operator's active check-in windows.

**Booked slots in the range reject the request with 409 and the list of conflicting bookings.** This mirrors §5.2: check-out cancels only `open` slots and booked ones survive. If a break could quietly dissolve a booking, it would become a backdoor around the rule that abandoning a committed customer is an explicit, auditable act. The operator cancels those bookings individually (§5.5) and then takes the break.

Returning early needs no separate mechanism: the operator checks in again (§5.1) for the remainder of the break. Because `one_session_per_operator_per_tick` excludes `cancelled` rows, fresh `open` rows for those ticks insert cleanly — and if the operator had meanwhile checked in elsewhere for them, the index rejects it, which is the correct outcome.

Break-cancelled slots are indistinguishable from checkout-cancelled ones, so availability lost to breaks is not reportable. That is accepted for MVP; a nullable `cancellation_reason` on `operator_slots` is a one-column migration whenever the analytics are wanted.

### 5.3 Discovery

`GET /discovery/locations?lat=&lng=[&radius=]` returns active locations within `DISCOVERY_RADIUS_M` (default 300 m), joined to open-slot counts for today in the business timezone, and each location's minimum active price.

Per location the response carries `id`, `code`, `site_code`, `site_name`, `name`, `description`, `distance_m`, `min_price`, `currency`, and the available slot times **each with its capacity** (how many operators are free at that tick). `site_name`, `name`, and `description` are `LocalizedText` objects carrying every supported locale (§2.4), not pre-resolved strings.

`GET /discovery/locations/:id` returns that location's active session types with prices, plus its slot times and capacities.

Only slots starting beyond `BOOKING_LEAD_TIME_MIN` are returned; a session starting in forty seconds is not bookable.

The radius is deliberately short. Locations are adjacent — a fast slope and a beginner slope at the same ski site — and the customer must be standing near the session's starting point, so discovery legitimately returns several locations at once.

Per design §3.2, no Redis caching in MVP.

### 5.4 Booking

`POST /bookings { location_id, start_at, location_session_type_id }`.

Guards: the customer's phone is verified; the session type belongs to that location and is active; `start_at` is grid-aligned and beyond the lead time.

One transaction at READ COMMITTED:

1. Run the fairness query from §3.3. No row returned → **409 `SLOT_UNAVAILABLE`**.
2. `UPDATE operator_slots SET status='booked'` for the selected row.
3. Read the session type's current `price` and `currency` into `price_snapshot`.
4. Insert the booking with `status='confirmed'`.

`GET /bookings` lists the caller's bookings — scoped by `customer_id` for customers and `operator_id` for operators. `GET /bookings/:id` is gated by `BookingAccessGuard`.

### 5.5 Booking lifecycle

Transitions are decided by a pure domain function and persisted by the service:

```ts
transition(current, event, actor, ctx) => Ok<{ next, stampField }> | Err<code>
```

No I/O, no Nest, and no clock of its own — `ctx` supplies the current time.

| From | Event | Actor | To |
|---|---|---|---|
| `confirmed` | `CUSTOMER_ACK` | customer | `customer_ready` |
| `confirmed`, `customer_ready` | `START` | operator | `in_progress` |
| `in_progress` | `END_SESSION` | operator | `completed` |
| `confirmed`, `customer_ready` | `CANCEL` | customer / operator / admin | `cancelled` |
| `confirmed`, `customer_ready` | `MARK_NO_SHOW` | operator | `no_show` |
| `confirmed`, `customer_ready` | `EXPIRE` | system | `expired` |

`END_SESSION` corresponds to the design §3.8 "Session ended" tap and stamps `session_end_at`; sub-project #4 keys video matching off it.

**`operators.presence` is maintained by these transitions**, which is the only thing that ever sets the `in_session` value: `START` sets the assigned operator to `in_session`, and `END_SESSION` returns them to `online` — or to `offline` if their check-in has since ended (§5.2). This runs in the same transaction as the status change, so presence can never disagree with the booking it describes.

Every populated cell **and every empty cell** becomes a table-driven unit test. That is how design §2's warning — "many edge cases that are easy to get wrong" — stops being true.

Endpoints: `POST /bookings/:id/ack`, `/start`, `/end`, `/cancel`, `/no-show`.

### 5.6 Policies settled here

Design §6 asks that several policies be decided early. This spec settles them:

**Cancellation releases inventory.** On cancel, if `start_at` is still beyond `BOOKING_LEAD_TIME_MIN`, the slot returns to `open` so another customer can book it; otherwise the slot is marked `cancelled`. Cancellation is permitted at any time before the session starts, but past `LATE_CANCELLATION_MIN` (default 60) the booking is stamped `late_cancellation = true` for future penalty logic. **No penalties in MVP** — payment happens after the session, so there is nothing to charge.

**No-show** is operator-initiated from `confirmed` or `customer_ready`. It does not affect future booking privileges in MVP.

**Expiry** applies to bookings still un-started after their tick has passed, and to `open` slots whose tick has passed. Both are implemented as a sweep routine here, exposed as an admin-triggerable command so the logic is complete and tested; sub-project #3 only has to schedule it.

**Readiness acknowledgement** has an endpoint here but no reminder push and no grace-window automation — those need the scheduler (#3). Until then, `START` is permitted from `confirmed` as well as `customer_ready`, so a missing acknowledgement never blocks a real session.

### 5.7 Endpoint surface

```
POST   /auth/otp/request                POST   /auth/otp/verify
POST   /auth/login                      POST   /auth/setup/:token
POST   /auth/refresh                    POST   /auth/logout
POST   /auth/logout-all

GET    /operators/me                    PATCH  /operators/me
POST   /operators/me/checkins           POST   /operators/me/checkins/:id/end
POST   /operators/me/breaks             GET    /operators/me/schedule

POST   /admin/operators                 GET    /admin/operators
POST   /admin/operators/:id/approve     POST   /admin/operators/:id/suspend
POST   /admin/locations                 PATCH  /admin/locations/:id
POST   /admin/locations/:id/session-types
PATCH  /admin/session-types/:id
POST   /admin/maintenance/sweep-expired

GET    /discovery/locations             GET    /discovery/locations/:id

POST   /bookings                        GET    /bookings
GET    /bookings/:id
POST   /bookings/:id/ack                POST   /bookings/:id/start
POST   /bookings/:id/end                POST   /bookings/:id/cancel
POST   /bookings/:id/no-show

GET    /health                          GET    /health/ready
```

---

## 6. Error model

A single Nest exception filter produces one envelope for every failure:

```json
{
  "error": {
    "code": "SLOT_UNAVAILABLE",
    "message": "That slot is no longer available.",
    "details": {},
    "requestId": "01J8..."
  }
}
```

Domain code throws typed domain errors; the filter alone maps them to HTTP status, so services never import HTTP concerns. The machine-readable `code` is the client contract — the React Native apps render Hebrew and English, so they switch on `code` and never parse `message`. `message` is English developer-facing text for logs and debugging, never surfaced to end users.

Consequently **`details` carries structured parameters, never prose** — `{ "field": "price", "min": 0 }`, not `"price must be at least 0"` — so the client can interpolate them into its own localized sentence. A message assembled server-side cannot be translated after the fact.

zod validation failures return 422 with field-level detail. 401 and 403 remain distinct. Unexpected errors return a generic 500 while the stack is logged under the same `requestId`.

---

## 7. Configuration

A zod-validated environment schema that fails at boot rather than at first use. Every value the design leaves tunable lives here rather than as a literal in code:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection |
| `REDIS_URL` | — | Cache and rate limiter |
| `JWT_SECRET` | — | Access token signing |
| `ACCESS_TOKEN_TTL` | `15m` | Design §8 |
| `REFRESH_TOKEN_TTL` | `30d` | Design §8 |
| `SMS_PROVIDER` | `sms4free` | Selects the `SmsProvider` implementation (§4.5) |
| `SMS4FREE_API_KEY` / `_USER` / `_PASS` / `_SENDER` | — | SMS4Free credentials and registered sender name |
| `SMS_SUPPORTED_COUNTRIES` | `IL` | ISO country codes the gateway will accept; others are rejected at request time |
| `OTP_SECRET` | — | HMAC key for code hashing; distinct from `JWT_SECRET` |
| `OTP_TTL_SEC` | `300` | Code lifetime |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong guesses before the code is burned |
| `OTP_RESEND_COOLDOWN_SEC` | `30` | Minimum gap between sends to one number |
| `OTP_DAILY_CAP_PER_PHONE` | `10` | Hard daily ceiling — cost control as much as abuse control |
| `BUSINESS_TIMEZONE` | `Asia/Jerusalem` | The single source of "today" |
| `SUPPORTED_LOCALES` | `en,he` | Validates `users.preferred_locale` and `LocalizedText` payloads |
| `DEFAULT_LOCALE` | `he` | Fallback for server-originated text |
| `SLOT_DURATION_MIN` | `15` | Grid tick size |
| `DISCOVERY_RADIUS_M` | `300` | Design §3.2 |
| `CHECKIN_LOCATION_TOLERANCE_M` | `150` | Physical-presence verification |
| `BOOKING_LEAD_TIME_MIN` | `5` | Minimum notice before a session |
| `LATE_CANCELLATION_MIN` | `60` | Late-cancellation stamp threshold |
| `SETUP_TOKEN_TTL` | `72h` | Operator invite link validity |

`.env.example` is committed. Secrets never are (design §9).

---

## 8. Observability

pino JSON logs. A request id is taken from the inbound header or generated, attached to every log line, and returned in error responses, so a screenshot from a customer maps to a log in one query. The redaction list covers passwords, tokens, OTP codes, and phone numbers.

`GET /health` is liveness. `GET /health/ready` verifies Postgres and Redis reachability.

---

## 9. Testing strategy

Development follows the superpowers TDD workflow: tests lead.

**Tier 1 — unit, zero I/O (Vitest).** The booking state machine as an exhaustive table covering every populated and every empty cell; grid alignment; E.164 normalization; the daily-load and tie-break ordering logic; token hashing; `LocalizedText` validation against `SUPPORTED_LOCALES`; the config schema.

**Tier 2 — integration, real Postgres + PostGIS + Redis.** Docker Compose supplies the services; tests run against a dedicated test database with migrations applied at suite start and truncation between tests. Covers repositories and the `ST_DWithin` discovery query against seeded geography.

The tier's central test justifies §3.3's entire design: **fire N concurrent booking attempts at a slot with capacity 2 and assert exactly 2 bookings succeed, N−2 return 409, and no operator is double-booked.** Fairness is asserted by seeding unequal daily loads and checking the assignment order. No mock can tell you whether `FOR UPDATE SKIP LOCKED` behaves.

**Tier 3 — E2E via supertest.** Full auth flows with `FakeSmsProvider` substituted at the `SmsProvider` port — the test reads the code out of the captured message, so the real OTP protocol is exercised end to end rather than stubbed. Includes refresh rotation and replay-detection. Plus an **authorization matrix**: for every protected endpoint, a wrong-role token and a wrong-owner token must both be rejected. It is table-driven, so adding an endpoint without adding a row is a visible gap. This matrix is the standing automated answer to design §9's IDOR warning.

`SmsProvider` is the only external boundary in scope, so it stays a one-method port with SMS4Free and fake implementations.

**Owning the OTP protocol adds tests that a managed service made unnecessary**, and they belong to whichever tier can actually observe the behavior. Tier 1: code generation covers the full `000000`–`999999` range including leading zeros, HMAC determinism, constant-time comparison, and the Hebrew template's 70-character ceiling. Tier 2 (real Redis): the TTL is **not** re-armed by a failed attempt, `HINCRBY` holds the cap under concurrent verifies, a burned code cannot be reused, and the cooldown and daily cap key off the normalized E.164 form so `0501234567` and `+972501234567` share one counter.

**No coverage percentage target.** Two hard gates instead: the state machine table is complete, and the authorization matrix covers every route.

---

## 10. CI

GitHub Actions against `git@github.com:ohadgreen/ACS-Backend.git`:

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration     # services: postgis/postgis:16-3.4, redis:7
pnpm build
pnpm audit                # design §9
```

---

## 11. Deferred decisions

These are recorded deliberately, not overlooked:

- **Site as an entity.** Site is a pair of fields on `locations` — `site_code` for grouping, `site_name` for localized display. It promotes to a table when site-level branding, address, or reporting is needed; localizing `site_name` denormalizes it across every location at a site, which strengthens that case somewhat.
- **Additional locales.** `LocalizedText` is `jsonb`, so adding Arabic or Russian is a data migration plus a `SUPPORTED_LOCALES` change, not a schema change. The CHECK constraints naming `'en'` and `'he'` are the only DDL that would need revising.
- **SMS provider routing by country.** MVP rejects numbers outside `SMS_SUPPORTED_COUNTRIES` (§4.5). When tourist bookings justify it, an `SmsRouter` picks a provider from the E.164 country code — SMS4Free for `+972`, another vendor elsewhere. The one-method port already accommodates this; nothing but the factory changes.
- **SMS delivery receipts.** `SmsProvider.send` resolves on gateway acceptance, not handset delivery. If undelivered codes become a support burden, add a delivery-status webhook per provider.
- **Operator payouts.** Design §7 defers gateway selection to sub-project #5; MVP handles payouts manually.
- **Discovery caching.** Redis caching of the geo query, per design §3.2, once load justifies it.
- **`pending` booking status.** Returns in #4 alongside identity photo, or in #5 if payment moves to booking time.
- **Location spoofing.** Design §9 accepts mock-GPS risk for MVP. `operator_checkins.checked_in_geog` retains reported positions so abuse patterns are detectable retrospectively.
- **No-show and late-cancellation penalties.** Fields are recorded; enforcement waits for payments.
