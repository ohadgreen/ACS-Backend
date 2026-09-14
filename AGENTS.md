# AGENTS.md

Guidance for coding agents working in this repository. Read this before changing code.

## What this is

The backend for **ACS** — an on-demand drone-video booking service. Customers stand at a
curated filming location, pick a session type, and book a 15-minute slot; the system assigns
an operator. Two React Native clients (customer, operator) consume this API.

Israel-focused: Hebrew and English, `Asia/Jerusalem` business timezone, ILS pricing, and an
Israeli SMS gateway.

**Terminology:** the source product design (`photographer-app-design.md`) says *photographer*.
Everywhere in this codebase that role is **`operator`** — the app serves drone operators.
Don't reintroduce the old term.

## Status

**Phase 1 (foundation + auth) and Phase 2 (locations, check-in, slot inventory, discovery,
bookings) are both implemented.** Nothing is planned beyond them: sub-projects #3–#5 (job
queue and scheduling, media pipeline, payments) have no spec yet.

| Document | Path |
|---|---|
| Approved design spec | `docs/superpowers/specs/2026-09-02-acs-backend-foundation-booking-design.md` |
| Phase 1 plan (executed) | `docs/superpowers/plans/completed/2026-09-06-acs-backend-phase1-foundation-auth.md` |
| Phase 2 plan (executed) | `docs/superpowers/plans/completed/2026-09-06-acs-backend-phase2-booking-loop.md` |

Plans under `completed/` are history, not documentation: they are the instructions that were
followed, kept because many commit messages cite "deviations from the plan" and are
unreadable without them. Both carry a header listing the substantive deviations. For how the
code works *now*, read this file and the code.

The spec is the authority on *why* things are shaped as they are. If you're about to change a
constraint, read the relevant section first — most of them exist to prevent a specific bug.

## Setup

```bash
docker compose up -d          # postgis + redis
pnpm install
cp .env.example .env          # SMS_PROVIDER=fake needs no gateway account
pnpm migrate                  # applies migrations AND creates the postgis extension
pnpm seed:admin admin@example.com 'a-long-admin-password' 'Admin'
pnpm start:dev
```

**pnpm only.** Never npm or yarn — the lockfile and the `pnpm-workspace.yaml` build-allowlist
are both pnpm-specific.

The CLI entry points read `process.env` directly — they never build a Nest container, so
`ConfigModule` is not there to load `.env` for them. Their scripts pass
`--env-file-if-exists=.env` so the file is loaded before the script runs. Without it both fail
with `DATABASE_URL is not set.`; to point one at another database, set the variable in the
environment, which takes precedence over the file.

## Commands

| Command | Notes |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over src **and** test |
| `pnpm lint` | eslint, type-checked rules |
| `pnpm test:unit` | `src/**/*.spec.ts` — no I/O, fast |
| `pnpm test:integration` | `test/**/*.spec.ts` — needs docker compose up |
| `pnpm build` | Uses `tsconfig.build.json` (excludes specs and CLI) |
| `pnpm migrate` | **Use this, not `drizzle-kit migrate`** — see Traps |
| `pnpm migrate:generate` | `drizzle-kit generate` after editing schema |

Run all five checks before claiming work is done: `typecheck`, `lint`, `test:unit`,
`test:integration`, `build`.

## Layout

```
src/
  main.ts                  API bootstrap (helmet, trust proxy, global filter/pipe, OpenAPI)
  common/
    auth/                  JwtAuthGuard, RolesGuard, @Public, @Roles, @CurrentUser
    crypto/                argon2id passwords, opaque token generation/hashing
    errors/                DomainError hierarchy, error codes, the one exception filter
    localized/             LocalizedText + the strict per-locale zod validator
    logging/               pino + request-id correlation
    rate-limit/            Redis fixed-window limiter
    time/                  grid.ts (tick alignment), business-day.ts (the only "today")
    validation/            zod pipe that throws our ValidationError
  infra/
    config/                zod env schema, requireEnv helper
    db/                    drizzle client, schema/, types.ts (geography), pg-error.ts, migrations
    redis/
  modules/
    auth/                  login, refresh rotation, otp/ (OtpService + templates), phone.ts
    sms/                   SmsProvider port + SMS4Free and fake adapters
    users/                 identity repository
    operators/             profile + admin invite/approve/suspend
    locations/             admin CRUD for locations and per-location session types
    presence/              check-in (slot materialization), check-out, breaks, schedule
    discovery/             the ST_DWithin query and its two public read endpoints
    bookings/              domain/ (pure state machine), fairness query, lifecycle, access guard
    maintenance/           expiry sweep, admin-triggerable
    health/
  cli/                     migrate, seed-admin
test/
  integration/             setup.ts (migrate once, truncate + flush between tests), db.helper.ts
  e2e/                     app.helper.ts (full app), authz-matrix.spec.ts
```

One module per domain, `controller → service → repository`. Services throw `DomainError`
subclasses; only `common/errors/exception.filter.ts` knows about HTTP status codes.

## Conventions that are enforced

- **Every route is protected by default.** `JwtAuthGuard` is global; `@Public()` is the only
  way out. Adding an endpoint without thinking about auth leaves it *protected*, which is the
  safe direction — but a probe or webhook that needs anonymous access must be marked
  explicitly. (`/health*` needed exactly this; it was a real bug.)
- **New protected route ⇒ new row in `test/e2e/authz-matrix.spec.ts`.** The matrix asserts 401
  for anonymous and 403 for every non-permitted role. It's the standing defense against
  object-level authorization bugs; a missing row is a visible gap. It ends with a row-count
  assertion, so adding a route without a row fails the suite rather than passing quietly —
  update the count deliberately, not reflexively. Currently 24 rows for 24 non-`@Public()`
  routes; the `@Public()` set is `/auth/*` except `logout-all`, `/discovery/*`, and
  `/health*`.
- **A booking has two owners**, so it has no `me`-shaped URL. `BookingAccessGuard` is the
  per-resource ownership check for `/bookings/:id`; the lifecycle routes repeat the same test
  in `BookingsService.act`. An unrelated caller gets 403 (they already know the id — what
  must not leak is the contents), a missing booking gets 404.
- **Errors:** throw `DomainError` subclasses, never `HttpException`, from services. `code` is
  the client contract (clients localize from it). `message` is English developer text.
  `details` carries **structured parameters, never prose** — a server-built sentence can't be
  translated.
- **Timestamps:** always `timestamptz`, stored UTC. Never use a bare `new Date()` to decide
  which *day* something belongs to — that must go through the configured `BUSINESS_TIMEZONE`.
  `common/time/business-day.ts` is the single place that computes it. Don't add business-day
  logic anywhere else, and don't reach for `plus({ hours: 24 })`: a DST day is 23 or 25 hours.
- **Session times are always on the 15-minute grid**, `:00 :15 :30 :45` with zero seconds.
  `common/time/grid.ts` decides alignment in the application; a database CHECK
  (`grid_aligned`) enforces it independently, using `AT TIME ZONE 'UTC'` so the expression
  stays immutable and therefore legal in a CHECK.
- **Capacity is the count of open `operator_slots` rows**, never a number in a column. That
  is what lets one `FOR UPDATE SKIP LOCKED` statement select a slot and assign its operator
  at once.
- **Localized display strings are `LocalizedText`** — a `jsonb` object carrying every
  `SUPPORTED_LOCALES` entry, CHECK-enforced. Responses return the whole object; the server
  never pre-resolves a locale, because the app switches language without re-fetching.
  Identity (`locations.code`, `site_code`, `location_session_types.code`) is a stable slug
  and is never localized.
- **A booking's `price_snapshot` and `currency` are copied at creation.** Editing a price
  must never change what an already-booked customer owes.
- **IDs:** UUIDv7, generated in the application (`uuidv7()`), never `gen_random_uuid()`.
- **Money:** `numeric(10,2)` plus an explicit `currency` column. Never floats.
- **Config:** every tunable belongs in `src/infra/config/env.schema.ts`, not as a literal.
  Read it with `requireEnv(config, 'KEY')` — `config.get()` widens to `T | undefined` even
  when the schema guarantees a value.
- **Secrets:** `JWT_SECRET` and `OTP_SECRET` are deliberately separate. Don't merge them.
- **SMS vendors:** no vendor name may appear outside `src/modules/sms/`. The `SmsProvider`
  port is one method; adding InforU or similar is a new adapter plus a case in `sms.module.ts`.

## Traps

These cost real debugging time. They're not stylistic.

**Version pins are load-bearing.**
- Every `@nestjs/*` package must be **v11**. `@nestjs/swagger`, `@nestjs/testing` and
  `@nestjs/jwt` all resolve to v12 by default, and v12 imports symbols `@nestjs/common@11`
  doesn't export — swagger v12 kills the process at boot.
- **TypeScript stays on 5.x.** `pnpm add -D typescript` resolves 7.x; Nest DI depends on
  `emitDecoratorMetadata`, which is not worth gambling on.

**pnpm 12 blocks build scripts.** A new dependency with a postinstall (esbuild, @swc/core)
fails the install until approved: `pnpm approve-builds <pkg> -y`. The allowlist lives in
`pnpm-workspace.yaml` — the `pnpm` field in `package.json` is ignored by pnpm 12.

**SWC needs decorator metadata.** `vitest.swc.ts` sets `legacyDecorator` and
`decoratorMetadata`. Without them Nest resolves every constructor-injected provider as
`undefined`. Don't "simplify" that config.

**Test environment lives in `vitest.integration.config.ts`, not in a helper.**
`ConfigModule.forRoot()` validates the environment while test imports are being hoisted —
before any `beforeAll` could set a variable. Setting `process.env` inside `createTestApp()`
is too late. Related: the config module ignores `.env` under `NODE_ENV=test`, because
otherwise a developer's local file silently points the suite at the dev database.

**A type alias can't be a DI token.** `AppConfig` is an alias, so `emitDecoratorMetadata`
records nothing for it — a parameter typed that way needs `@Inject(ConfigService)`.

**`pnpm migrate`, not `drizzle-kit migrate`.** `src/cli/migrate.ts` creates the `postgis`
extension before applying migrations; drizzle-kit doesn't emit extensions, so on a fresh
database the first `geography` migration fails.

**Use `jsonb_exists(col, 'en')`, never `col ? 'en'`.** node-postgres parses `?` as a
parameter placeholder; the operator form is valid SQL that fails at runtime.

**Drizzle wraps driver errors.** A constraint violation surfaces on the `cause` chain, not in
the message — so `rejects.toThrow(/some_constraint/)` never matches and passes on any failure
at all. Use `infra/db/pg-error.ts` (`isUniqueViolation`, `violatedConstraint`), which walks
the chain, and always match the constraint *name*: it proves which rule fired, and stops an
unrelated unique index being mistranslated into the wrong domain error.

**`operators.presence` is display state only.** Nothing reads it for correctness.
Availability is *which `operator_slots` rows exist and are open* — discovery must never
consult `presence`. Check-in and the booking transitions maintain it, in the same transaction
as the change it describes.

**`z.coerce.date()` in a DTO crashes the process at boot.** It has no JSON Schema
representation, so zod throws `Date cannot be represented in JSON Schema` while
`SwaggerModule.createDocument` runs — before `app.listen`, and nowhere near a request. Parse
timestamps with `z.iso.datetime({ offset: true }).transform((v) => new Date(v))`.

**`FOR UPDATE` cannot be applied to the nullable side of an outer join.** The fairness query
in `bookings.repository.ts` joins a `LEFT JOIN LATERAL` load subquery, so it must say
`FOR UPDATE OF s SKIP LOCKED`. Drop the `OF s` and Postgres rejects the statement outright —
every booking fails, not just contended ones.

**A POST that creates nothing needs `@HttpCode(200)`.** Nest answers POST with 201 by
default. Every lifecycle, check-out, break and sweep route is 200; only `POST /bookings`,
`/admin/locations*` and `/admin/operators` genuinely create.

**drizzle-kit quotes custom column types.** A `geography(Point,4326)` column is emitted as
`"geography(Point,4326)"`, which Postgres reads as a type *named* that and rejects. Unquote it
by hand in the generated migration. drizzle-kit also omits GIST indexes for those columns —
`locations_geog_idx` is hand-written in `drizzle/0001_locations.sql`, and without it every
`ST_DWithin` in discovery is a sequential scan.

**An index predicate takes a bare column name.** `sql`${t.status} <> 'cancelled'`` inside a
`uniqueIndex(...).where(...)` renders a table-qualified reference, which is not valid in
`CREATE INDEX ... WHERE`. Write `sql`status <> 'cancelled'``. The same predicate must be
repeated verbatim in `onConflictDoNothing({ target, where })` for Postgres to infer the
partial index — and note it is `where` there, not `targetWhere` (that name is doUpdate-only).

## Testing

Tests lead — this codebase was built TDD and the discipline is worth keeping.

- **Unit** (`src/**/*.spec.ts`): pure logic, zero I/O.
- **Integration** (`test/**/*.spec.ts`): real Postgres + Redis. Migrations run once per suite;
  tables are truncated and Redis flushed between tests.
- **E2E** (`test/e2e/`): full app via `createTestApp()`. Prefer this over hand-assembling a
  partial module — a subset without the global guards will happily miss auth bugs.

Four behaviours have tests that exist because getting them wrong is subtle, and all four must
keep passing:

- a failed OTP attempt must **not** re-arm the code's TTL;
- the OTP attempt cap must hold under concurrent verifies;
- **12 concurrent bookings on a capacity-2 slot must yield exactly 2**, with two distinct
  operators (`test/integration/booking-concurrency.spec.ts`). More than 2 winners means
  `FOR UPDATE SKIP LOCKED` has been lost;
- the booking state machine's test walks the **full cartesian product** — 7 statuses x 6
  events x 4 actors = 168 cells, 14 allowed and 154 rejected. Adding a status or an event
  means the grid-coverage assertion fails until the table is updated.

**Time-dependent fixtures must derive their tick from the clock, not a literal hour.**
Discovery only offers `[now + BOOKING_LEAD_TIME_MIN, end of today)`, so a hard-coded
`21:00Z` is the *end* of the Asia/Jerusalem business day in summer and gets filtered out.
See `bookableTick()` in `test/e2e/discovery.spec.ts`. Where a case needs a deliberately
imminent slot, floor to the grid rather than ceil — rounding up can push it out of the
window under test.

Stub only at the port boundary (`SmsProvider`). The OTP e2e tests read the real code out of
`FakeSmsProvider`, so the whole protocol runs rather than being mocked away.

## Commits

Conventional-style prefixes (`feat:`, `fix:`, `docs:`, `refactor:`). Explain *why*, and
record any deviation from the plan or spec together with the reason — the Phase 1 and Phase 2
history is the model. Don't amend; add commits.

## Known gaps

- **The SMS4Free adapter has never called SMS4Free.** It was written from
  `docs/misc/sms-otp-sketch.js`, which itself flagged the endpoint URL as unconfirmed. Verify
  the URL, the registered sender name, and the success/failure status codes against current
  vendor docs before relying on it.
- Non-Israeli numbers are rejected at OTP request with `PHONE_COUNTRY_UNSUPPORTED`. Provider
  routing by country is deferred; the port already accommodates it.
- No job queue, media pipeline, or payments yet — sub-projects #3–#5, unplanned.
- **The expiry sweep is admin-triggered only** (`POST /admin/maintenance/sweep-expired`).
  `MaintenanceService.sweepExpired(now?)` takes an injectable clock precisely so #3 can put a
  BullMQ schedule in front of it without touching the logic.
- **No readiness reminders yet**, which is why `START` is permitted straight from `confirmed`
  as well as `customer_ready`. Until #3 sends the reminder, a missing customer
  acknowledgement must never block a real session. Don't "tighten" that rule first.
- **`late_cancellation` is recorded but never charged.** Payment happens after the session,
  so there is nothing to penalise in the MVP; the flag exists for whatever #5 decides.
- **`GET /bookings` is party-scoped and refuses admins.** An unfiltered dump of every booking
  is a different endpoint with different pagination needs, and hasn't been specified.
