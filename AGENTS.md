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

**Phase 1 (foundation + auth) is implemented and merged.** Phase 2 (locations, check-in, slot
inventory, discovery, bookings) is fully planned but not started.

| Document | Path |
|---|---|
| Approved design spec | `docs/superpowers/specs/2026-09-02-acs-backend-foundation-booking-design.md` |
| Phase 1 plan (done) | `docs/superpowers/plans/2026-09-06-acs-backend-phase1-foundation-auth.md` |
| Phase 2 plan (next) | `docs/superpowers/plans/2026-09-06-acs-backend-phase2-booking-loop.md` |

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
    logging/               pino + request-id correlation
    rate-limit/            Redis fixed-window limiter
    validation/            zod pipe that throws our ValidationError
  infra/
    config/                zod env schema, requireEnv helper
    db/                    drizzle client, schema/, migration runner
    redis/
  modules/
    auth/                  login, refresh rotation, otp/ (OtpService + templates), phone.ts
    sms/                   SmsProvider port + SMS4Free and fake adapters
    users/                 identity repository
    operators/             profile + admin invite/approve/suspend
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
  object-level authorization bugs; a missing row is a visible gap.
- **Errors:** throw `DomainError` subclasses, never `HttpException`, from services. `code` is
  the client contract (clients localize from it). `message` is English developer text.
  `details` carries **structured parameters, never prose** — a server-built sentence can't be
  translated.
- **Timestamps:** always `timestamptz`, stored UTC. Never use a bare `new Date()` to decide
  which *day* something belongs to — that must go through the configured `BUSINESS_TIMEZONE`.
  Phase 2 adds `common/time/business-day.ts` as the single place that computes it; until then
  there is no business-day logic in the codebase, and none should be added ad hoc.
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

**Drizzle wraps driver errors.** A constraint violation surfaces as
`error.cause.constraint`, not in the message. Assert on the constraint name — it proves which
rule fired.

**`operators.presence` is display state only.** The column exists but nothing reads it for
correctness. When Phase 2 lands, availability is *which `operator_slots` rows exist and are
open* — discovery must never consult `presence`, and the Phase 2 checklist greps for it.

## Testing

Tests lead — this codebase was built TDD and the discipline is worth keeping.

- **Unit** (`src/**/*.spec.ts`): pure logic, zero I/O.
- **Integration** (`test/**/*.spec.ts`): real Postgres + Redis. Migrations run once per suite;
  tables are truncated and Redis flushed between tests.
- **E2E** (`test/e2e/`): full app via `createTestApp()`. Prefer this over hand-assembling a
  partial module — a subset without the global guards will happily miss auth bugs.

Two behaviours have tests that exist because getting them wrong is subtle, and both must keep
passing: a failed OTP attempt must **not** re-arm the code's TTL, and the OTP attempt cap must
hold under concurrent verifies. Phase 2 adds a third: 12 concurrent bookings on a capacity-2
slot must yield exactly 2.

Stub only at the port boundary (`SmsProvider`). The OTP e2e tests read the real code out of
`FakeSmsProvider`, so the whole protocol runs rather than being mocked away.

## Commits

Conventional-style prefixes (`feat:`, `fix:`, `docs:`, `refactor:`). Explain *why*, and
record any deviation from the plan or spec together with the reason — the Phase 1 history is
the model. Don't amend; add commits.

## Known gaps

- **The SMS4Free adapter has never called SMS4Free.** It was written from
  `docs/misc/sms-otp-sketch.js`, which itself flagged the endpoint URL as unconfirmed. Verify
  the URL, the registered sender name, and the success/failure status codes against current
  vendor docs before relying on it.
- Non-Israeli numbers are rejected at OTP request with `PHONE_COUNTRY_UNSUPPORTED`. Provider
  routing by country is deferred; the port already accommodates it.
- No job queue, media pipeline, or payments yet — sub-projects #3–#5, unplanned.
