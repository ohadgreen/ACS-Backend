# ACS Backend Phase 3 — Scheduling, Push Notifications & Session Readiness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the background worker, the job queue, and push notifications, and use them to notify a customer at session start and let the operator acknowledge on their behalf.

**Architecture:** A second entrypoint (`src/worker.ts`) boots the same Nest modules without an HTTP listener; processors are declared only in `WorkerModule`, so the API process can never consume jobs. A repeatable BullMQ tick runs set-based scans against Postgres — Postgres owns *what is due*, BullMQ owns *dispatch*. Push delivery sits behind a `PushProvider` port with Expo and fake adapters, exactly as `SmsProvider` does.

**Tech Stack:** NestJS 11, Drizzle, Postgres 16 + PostGIS, BullMQ 5 over Redis 7, Expo Push, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-16-acs-backend-phase3-scheduling-notifications-design.md`

## Global Constraints

Copied from `AGENTS.md` and the spec. Every task's requirements implicitly include this section.

- **pnpm only.** Never npm or yarn.
- **Every `@nestjs/*` package must be v11.** TypeScript stays on 5.x.
- **New dependency with a postinstall** needs `pnpm approve-builds <pkg> -y`; the allowlist lives in `pnpm-workspace.yaml`, not `package.json`.
- **Run all five checks before claiming a task done:** `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build`.
- **`pnpm migrate`, never `drizzle-kit migrate`** — the former creates the postgis extension first.
- **Every route is protected by default.** A new protected route requires a new row in `test/e2e/authz-matrix.spec.ts` and a deliberate update to its row-count assertion.
- **Services throw `DomainError` subclasses, never `HttpException`.** `details` carries structured parameters, never prose.
- **IDs are UUIDv7 generated in the application** via `uuidv7()`, never `gen_random_uuid()`.
- **Timestamps are always `timestamptz`,** stored UTC.
- **Every tunable belongs in `src/infra/config/env.schema.ts`,** read with `requireEnv(config, 'KEY')`.
- **Index predicates take bare column names** — `` sql`revoked_at IS NULL` ``, never `` sql`${t.revokedAt} IS NULL` ``.
- **No vendor name may appear outside its adapter directory** (`src/modules/notifications/` for push, as `src/modules/sms/` is for SMS).
- **Test environment lives in the vitest config files,** never in a helper — `ConfigModule.forRoot()` validates during import hoisting.
- **Commits:** conventional prefixes, explain *why*, record deviations from this plan with the reason.

---

## Deviations from the spec, decided while planning

Record these in the final commit message; they are deliberate.

1. **`PUSH_SEND_FAILED` is not added to `ErrorCodes`.** Spec §8 lists it. `error-codes.ts` documents itself as "The client contract", and this code never reaches a client — it exists only to make a BullMQ job retry. It becomes a plain `PushSendError extends Error` inside the notifications module. `DEVICE_NOT_FOUND` is still added.

2. **`NotificationsService.notify(userId, key, data)` — the third argument is the push `data` payload, not template parameters.** Spec §5.3 implies template params. Neither template in this phase interpolates anything, so parameter plumbing would be built with no consumer. What *is* needed is a `bookingId` in the push payload so tapping the notification opens the right screen. Templates therefore stay parameterless constants; `data` is carried through to the client.

3. **The tick is registered with BullMQ's `upsertJobScheduler`, not `queue.add({ repeat })`.** Spec §10 records "a repeatable job's identity is derived from its options" as a trap requiring manual cleanup on boot. `upsertJobScheduler` is keyed by a stable scheduler id and replaces its own schedule when options change, which removes the trap instead of documenting it.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/infra/queue/queue.constants.ts` | Queue names, job names, DI tokens |
| `src/infra/queue/queue.module.ts` | BullMQ connection + push `Queue` producer, shutdown |
| `src/infra/db/schema/devices.ts` | `device_tokens` table + `device_platform` enum |
| `src/modules/notifications/push-provider.ts` | Port, message/result types, `PushSendError` |
| `src/modules/notifications/expo-push.provider.ts` | Expo adapter |
| `src/modules/notifications/fake-push.provider.ts` | In-memory adapter for dev and tests |
| `src/modules/notifications/fake-push.provider.spec.ts` | Unit |
| `src/modules/notifications/push-templates.ts` | Locale-keyed notification text |
| `src/modules/notifications/push-templates.spec.ts` | Unit |
| `src/modules/notifications/devices.repository.ts` | Token register / revoke / list |
| `src/modules/notifications/devices.controller.ts` | `POST /me/devices`, `POST /me/devices/revoke` |
| `src/modules/notifications/dto/device.dto.ts` | zod DTOs |
| `src/modules/notifications/notifications.service.ts` | Enqueue a notification (producer) |
| `src/modules/notifications/notifications.module.ts` | Producer side, imported by `AppModule` |
| `src/modules/notifications/push.processor.ts` | Worker side: resolve, render, send, reap |
| `src/modules/notifications/notifications.worker.module.ts` | Worker side wiring |
| `src/modules/scheduling/readiness.repository.ts` | The start-notification claim scan |
| `src/modules/scheduling/scheduler.processor.ts` | The tick worker + schedule registration |
| `src/modules/scheduling/scheduling.module.ts` | Worker-only module |
| `src/worker.module.ts` | Worker module graph |
| `src/worker.ts` | Worker entrypoint |
| `test/integration/device-tokens.spec.ts` | Repository + index behaviour |
| `test/integration/push-processor.spec.ts` | Send path and token reaping |
| `test/integration/readiness-scan.spec.ts` | Claim scan + concurrency |
| `test/integration/sweep-grace.spec.ts` | The §4.4 correction |
| `test/e2e/devices.spec.ts` | Device endpoints |
| `test/e2e/operator-ack.spec.ts` | Operator acknowledgement |

**Modified**

| Path | Change |
|---|---|
| `package.json` | `bullmq` dependency; `start:worker`, `start:worker:dev` scripts |
| `src/infra/config/env.schema.ts` | Five new variables |
| `.env.example` | Document the new variables |
| `vitest.unit.config.ts`, `vitest.integration.config.ts` | `PUSH_PROVIDER=fake` |
| `src/infra/db/schema/index.ts` | Export `devices` |
| `src/infra/db/schema/bookings.ts` | `start_notified_at` + partial index |
| `src/common/errors/error-codes.ts` | `DEVICE_NOT_FOUND` |
| `src/app.module.ts` | Import `QueueModule`, `NotificationsModule` |
| `src/modules/bookings/domain/types.ts` | (unchanged — listed to confirm no edit needed) |
| `src/modules/bookings/domain/state-machine.ts` | `CUSTOMER_ACK` actors |
| `src/modules/bookings/domain/state-machine.spec.ts` | Grid counts 15 / 153 |
| `src/modules/bookings/bookings.controller.ts` | `ack` roles + actor |
| `src/modules/bookings/bookings.service.ts` | Notify operator on customer ack |
| `src/modules/bookings/bookings.module.ts` | Import `NotificationsModule` |
| `src/modules/maintenance/maintenance.repository.ts` | Grace period on the booking predicate |
| `test/e2e/authz-matrix.spec.ts` | +2 rows, `ack` allows operator, count 26 |
| `AGENTS.md` | Status, layout, conventions, traps, known gaps |
| `drizzle/` | Two generated migrations |

---

## Task 1: Dependencies, configuration, and test environment

Everything later tasks read from config. Nothing works until this lands.

**Files:**
- Modify: `package.json`
- Modify: `src/infra/config/env.schema.ts`
- Modify: `.env.example`
- Modify: `vitest.unit.config.ts`
- Modify: `vitest.integration.config.ts`
- Test: `src/infra/config/env.schema.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Env` gains `PUSH_PROVIDER: 'expo' | 'fake'`, `EXPO_ACCESS_TOKEN: string | undefined`, `QUEUE_PREFIX: string`, `SCHEDULER_TICK_SEC: number`, `WORKER_CONCURRENCY: number`. All read with `requireEnv(config, KEY)`.

- [ ] **Step 1: Install BullMQ and confirm the scheduler API exists**

```bash
pnpm add bullmq
pnpm approve-builds -y 2>/dev/null || true
node -e "const {Queue}=require('bullmq'); console.log('upsertJobScheduler' in Queue.prototype)"
```

Expected: `true`. If it prints `false`, the installed BullMQ predates job schedulers — stop and report, because Task 12 depends on this API.

- [ ] **Step 2: Write the failing config test**

Append to `src/infra/config/env.schema.spec.ts`:

```ts
describe('phase 3 configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/acs',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'x'.repeat(32),
    OTP_SECRET: 'y'.repeat(32),
    SMS_PROVIDER: 'fake',
  };

  it('defaults the push and queue settings', () => {
    const env = envSchema.parse(base);
    expect(env.PUSH_PROVIDER).toBe('expo');
    expect(env.QUEUE_PREFIX).toBe('acs');
    expect(env.SCHEDULER_TICK_SEC).toBe(15);
    expect(env.WORKER_CONCURRENCY).toBe(5);
  });

  it('rejects an unknown push provider', () => {
    expect(() => envSchema.parse({ ...base, PUSH_PROVIDER: 'onesignal' })).toThrow();
  });

  // Unlike the SMS credentials, Expo needs no access token unless the project
  // has enabled enhanced push security, so the schema must not demand one.
  it('accepts PUSH_PROVIDER=expo with no access token', () => {
    expect(() => envSchema.parse({ ...base, PUSH_PROVIDER: 'expo' })).not.toThrow();
  });

  it('coerces the tick interval from a string', () => {
    expect(envSchema.parse({ ...base, SCHEDULER_TICK_SEC: '30' }).SCHEDULER_TICK_SEC).toBe(30);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm test:unit -- env.schema`
Expected: FAIL — `env.PUSH_PROVIDER` is `undefined`.

- [ ] **Step 4: Add the variables to the schema**

In `src/infra/config/env.schema.ts`, inside the `z.object({ ... })`, after the `LATE_CANCELLATION_MIN` line:

```ts
    // Push transport. EXPO_ACCESS_TOKEN is deliberately NOT conditionally
    // required the way the SMS credentials are: Expo accepts unauthenticated
    // sends unless a project opts into enhanced security, so demanding one
    // would block the common case at boot for no safety gain.
    PUSH_PROVIDER: z.enum(['expo', 'fake']).default('expo'),
    EXPO_ACCESS_TOKEN: z.string().optional(),

    // Namespaces BullMQ's Redis keys, so a shared Redis cannot cross
    // environments' queues into each other.
    QUEUE_PREFIX: z.string().default('acs'),
    SCHEDULER_TICK_SEC: z.coerce.number().int().positive().default(15),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm test:unit -- env.schema`
Expected: PASS.

- [ ] **Step 6: Point the test suites at the fake push provider**

In **both** `vitest.unit.config.ts` and `vitest.integration.config.ts`, add to the `testEnv` object beside `SMS_PROVIDER: 'fake'`:

```ts
  PUSH_PROVIDER: 'fake',
```

This has to be here rather than in `test/e2e/app.helper.ts`: `ConfigModule.forRoot()` validates the environment while test imports are hoisted, so a `beforeAll` runs too late.

- [ ] **Step 7: Document the variables**

Append to `.env.example`:

```
# PUSH_PROVIDER=fake records notifications in memory instead of sending them,
# so local development needs no Expo project. EXPO_ACCESS_TOKEN is only needed
# if the Expo project has enhanced push security enabled.
PUSH_PROVIDER=fake
EXPO_ACCESS_TOKEN=

# BullMQ. QUEUE_PREFIX namespaces Redis keys so environments sharing a Redis
# do not consume each other's jobs.
QUEUE_PREFIX=acs
SCHEDULER_TICK_SEC=15
WORKER_CONCURRENCY=5
```

- [ ] **Step 8: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
git add package.json pnpm-lock.yaml pnpm-workspace.yaml src/infra/config/env.schema.ts src/infra/config/env.schema.spec.ts .env.example vitest.unit.config.ts vitest.integration.config.ts
git commit -m "feat: configuration for the queue and push transport

EXPO_ACCESS_TOKEN is optional rather than conditionally required like the SMS
credentials, because Expo accepts unauthenticated sends unless a project opts
into enhanced security."
```

---

## Task 2: `device_tokens` schema, migration, and repository

A push needs an address. The server knows `users.id`; Expo knows a per-installation token only the client can obtain.

**Files:**
- Create: `src/infra/db/schema/devices.ts`
- Modify: `src/infra/db/schema/index.ts`
- Create: `src/modules/notifications/devices.repository.ts`
- Test: `test/integration/device-tokens.spec.ts`

**Interfaces:**
- Consumes: `users` schema, `DRIZZLE`/`Db` from `src/infra/db/drizzle.module`.
- Produces:
  - `deviceTokens` table, `devicePlatform` enum, `type DeviceToken`
  - `DevicesRepository.register(userId: string, token: string, platform: 'ios' | 'android'): Promise<void>`
  - `DevicesRepository.revoke(userId: string, token: string): Promise<boolean>` — `false` if the caller held no such active token
  - `DevicesRepository.listActiveFor(userId: string): Promise<string[]>`
  - `DevicesRepository.revokeTokens(tokens: string[]): Promise<void>`

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/device-tokens.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { deviceTokens, users } from '../../src/infra/db/schema';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { getTestDb } from './db.helper';

const db = getTestDb();
const repo = new DevicesRepository(db);

const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

async function makeCustomer(phone: string) {
  const id = uuidv7();
  await db.insert(users).values({ id, role: 'customer', phone, preferredLocale: 'he' });
  return id;
}

let alice: string;
let bob: string;

beforeEach(async () => {
  alice = await makeCustomer('+972500000001');
  bob = await makeCustomer('+972500000002');
});

describe('device token registration', () => {
  it('stores a token and returns it as active', async () => {
    await repo.register(alice, TOKEN, 'ios');
    expect(await repo.listActiveFor(alice)).toEqual([TOKEN]);
  });

  it('is idempotent — re-registering touches last_seen_at instead of duplicating', async () => {
    await repo.register(alice, TOKEN, 'ios');
    const [first] = await db.select().from(deviceTokens);
    await repo.register(alice, TOKEN, 'ios');

    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime());
  });

  it('records a platform change on re-registration', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.register(alice, TOKEN, 'android');
    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe('android');
  });

  // The privacy case: one handset, two users. If the old binding survived,
  // Alice's booking notifications would arrive on Bob's phone.
  it('revokes the previous owner when a live token is claimed by another user', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.register(bob, TOKEN, 'ios');

    expect(await repo.listActiveFor(alice)).toEqual([]);
    expect(await repo.listActiveFor(bob)).toEqual([TOKEN]);

    // Revoked, not deleted: the history of who held the device is the only
    // evidence available if a misdelivery is ever reported.
    const all = await db.select().from(deviceTokens);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.revokedAt !== null)).toHaveLength(1);
  });

  it('allows one user to hold several devices', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.register(alice, 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]', 'android');
    expect(await repo.listActiveFor(alice)).toHaveLength(2);
  });
});

describe('device token revocation', () => {
  it('revokes a token the caller holds', async () => {
    await repo.register(alice, TOKEN, 'ios');
    expect(await repo.revoke(alice, TOKEN)).toBe(true);
    expect(await repo.listActiveFor(alice)).toEqual([]);
  });

  it('reports false for a token the caller does not hold', async () => {
    await repo.register(alice, TOKEN, 'ios');
    expect(await repo.revoke(bob, TOKEN)).toBe(false);
    expect(await repo.listActiveFor(alice)).toEqual([TOKEN]);
  });

  it('bulk-revokes dead tokens regardless of owner', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.revokeTokens([TOKEN]);
    const live = await db
      .select()
      .from(deviceTokens)
      .where(and(eq(deviceTokens.token, TOKEN), isNull(deviceTokens.revokedAt)));
    expect(live).toEqual([]);
  });

  it('tolerates an empty bulk revocation', async () => {
    await expect(repo.revokeTokens([])).resolves.toBeUndefined();
  });

  // A revoked token must be re-registerable: uninstall, reinstall, same token.
  it('allows a revoked token to be registered again', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.revokeTokens([TOKEN]);
    await repo.register(alice, TOKEN, 'ios');
    expect(await repo.listActiveFor(alice)).toEqual([TOKEN]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- device-tokens`
Expected: FAIL — cannot resolve `devices.repository`.

- [ ] **Step 3: Write the schema**

Create `src/infra/db/schema/devices.ts`:

```ts
import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const devicePlatform = pgEnum('device_platform', ['ios', 'android']);

/**
 * The map from a user to the addresses a push can actually reach. A table
 * rather than a column on `users`, because the relationship is not one-to-one:
 * one user has several devices, tokens rotate on reinstall, and a handset can
 * change owner.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    token: text('token').notNull(),
    platform: devicePlatform('platform').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    // Partial, so a token freed by an uninstall or an owner change can be
    // registered again. A total unique index would make a reinstall fail.
    // Bare column name: a table-qualified reference is not valid in
    // CREATE INDEX ... WHERE.
    uniqueIndex('device_tokens_active_token').on(t.token).where(sql`revoked_at IS NULL`),
    index('device_tokens_user_idx').on(t.userId).where(sql`revoked_at IS NULL`),
  ],
);

export type DeviceToken = typeof deviceTokens.$inferSelect;
```

Add to `src/infra/db/schema/index.ts`, after the `bookings` line:

```ts
export * from './devices';
```

- [ ] **Step 4: Write the repository**

Create `src/modules/notifications/devices.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { deviceTokens } from '../../infra/db/schema';

@Injectable()
export class DevicesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Registering is idempotent, because the client cannot know whether it has
   * already reported its current token — the OS may rotate it between launches,
   * so the app registers on every foreground and the server absorbs it.
   */
  async register(userId: string, token: string, platform: 'ios' | 'android'): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      // One handset, two users: customer A logs out, customer B logs in, and B
      // presents the token bound to A. Without this, A's booking notifications
      // arrive on B's phone.
      await tx
        .update(deviceTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(deviceTokens.token, token),
            isNull(deviceTokens.revokedAt),
            ne(deviceTokens.userId, userId),
          ),
        );

      await tx
        .insert(deviceTokens)
        .values({ id: uuidv7(), userId, token, platform, createdAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: deviceTokens.token,
          // Repeated verbatim from the index predicate so Postgres can infer
          // the partial index. Note this is `targetWhere` — onConflictDoNothing
          // spells the same thing `where`.
          targetWhere: sql`revoked_at IS NULL`,
          set: { lastSeenAt: now, platform },
        });
    });
  }

  /** False when the caller holds no such active token — the controller turns that into a 404. */
  async revoke(userId: string, token: string): Promise<boolean> {
    const rows = await this.db
      .update(deviceTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(deviceTokens.userId, userId),
          eq(deviceTokens.token, token),
          isNull(deviceTokens.revokedAt),
        ),
      )
      .returning({ id: deviceTokens.id });
    return rows.length > 0;
  }

  async listActiveFor(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)));
    return rows.map((r) => r.token);
  }

  /** Used by the push processor to reap tokens the transport reported dead. */
  async revokeTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.db
      .update(deviceTokens)
      .set({ revokedAt: new Date() })
      .where(and(inArray(deviceTokens.token, tokens), isNull(deviceTokens.revokedAt)));
  }
}
```

- [ ] **Step 5: Generate the migration and unquote nothing**

```bash
pnpm migrate:generate
```

Open the generated `drizzle/0004_*.sql`. Confirm both index predicates read `WHERE "revoked_at" IS NULL` (or unquoted equivalent) and **not** `WHERE "device_tokens"."revoked_at" IS NULL` — a table-qualified reference is rejected by `CREATE INDEX`. Fix by hand if drizzle-kit emitted one.

```bash
pnpm migrate
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm test:integration -- device-tokens`
Expected: PASS, 10 tests.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add src/infra/db/schema/devices.ts src/infra/db/schema/index.ts src/modules/notifications/devices.repository.ts test/integration/device-tokens.spec.ts drizzle/
git commit -m "feat: device token registry with owner reassignment

The unique index is partial on revoked_at IS NULL so a token freed by an
uninstall can be registered again. Registration revokes a live binding held by
a different user: one handset changing hands would otherwise keep delivering
the previous user's booking notifications to the new one."
```

---

## Task 3: `PushProvider` port, fake and Expo adapters

Mirrors `src/modules/sms/` exactly: one-method port, real adapter, fake adapter, vendor name confined to the directory.

**Files:**
- Create: `src/modules/notifications/push-provider.ts`
- Create: `src/modules/notifications/fake-push.provider.ts`
- Create: `src/modules/notifications/fake-push.provider.spec.ts`
- Create: `src/modules/notifications/expo-push.provider.ts`
- Create: `src/modules/notifications/expo-push.provider.spec.ts`

**Interfaces:**
- Consumes: `AppConfig`, `requireEnv` from `src/infra/config/typed-config`.
- Produces:
  - `PUSH_PROVIDER: symbol` — DI token
  - `interface PushMessage { token: string; title: string; body: string; data?: Record<string, string> }`
  - `type PushFailure = 'DEVICE_NOT_REGISTERED' | 'TRANSIENT' | 'INVALID'`
  - `interface PushResult { token: string; ok: boolean; error?: PushFailure }`
  - `interface PushProvider { send(messages: PushMessage[]): Promise<PushResult[]> }`
  - `class PushSendError extends Error`
  - `class FakePushProvider` with `readonly sent: PushMessage[]`, `failNextWith?: PushFailure`, `reset()`
  - `class ExpoPushProvider implements PushProvider`

- [ ] **Step 1: Write the failing unit tests**

Create `src/modules/notifications/fake-push.provider.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { FakePushProvider } from './fake-push.provider';

const message = (token: string) => ({ token, title: 'T', body: 'B' });

describe('FakePushProvider', () => {
  let provider: FakePushProvider;
  beforeEach(() => {
    provider = new FakePushProvider();
  });

  it('records every message and reports success', async () => {
    const results = await provider.send([message('a'), message('b')]);
    expect(provider.sent).toHaveLength(2);
    expect(results).toEqual([
      { token: 'a', ok: true },
      { token: 'b', ok: true },
    ]);
  });

  it('fails one send when armed, then recovers', async () => {
    provider.failNextWith = 'TRANSIENT';
    const first = await provider.send([message('a')]);
    expect(first[0]).toEqual({ token: 'a', ok: false, error: 'TRANSIENT' });

    const second = await provider.send([message('a')]);
    expect(second[0]).toEqual({ token: 'a', ok: true });
  });

  it('does not record messages from a failed send', async () => {
    provider.failNextWith = 'DEVICE_NOT_REGISTERED';
    await provider.send([message('a')]);
    expect(provider.sent).toEqual([]);
  });

  it('clears recorded messages on reset', async () => {
    await provider.send([message('a')]);
    provider.reset();
    expect(provider.sent).toEqual([]);
  });

  it('returns an empty result set for an empty batch', async () => {
    expect(await provider.send([])).toEqual([]);
  });
});
```

Create `src/modules/notifications/expo-push.provider.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider } from './expo-push.provider';

const provider = () => new ExpoPushProvider(undefined);
const message = (token: string) => ({ token, title: 'T', body: 'B' });

const respondWith = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExpoPushProvider', () => {
  it('maps an ok ticket to success', async () => {
    respondWith({ data: [{ status: 'ok', id: '1' }] });
    expect(await provider().send([message('a')])).toEqual([{ token: 'a', ok: true }]);
  });

  // An uninstalled app is the only error worth acting on: the token is dead
  // forever, and the caller reaps it.
  it('maps DeviceNotRegistered so the caller can reap the token', async () => {
    respondWith({
      data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }],
    });
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'DEVICE_NOT_REGISTERED' },
    ]);
  });

  it('maps a rate-limit ticket to TRANSIENT so the job retries', async () => {
    respondWith({
      data: [{ status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } }],
    });
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'TRANSIENT' },
    ]);
  });

  it('maps an oversized message to INVALID, which must not be retried', async () => {
    respondWith({
      data: [{ status: 'error', message: 'too big', details: { error: 'MessageTooBig' } }],
    });
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'INVALID' },
    ]);
  });

  // A partial failure is routine, so the batch must report per message rather
  // than throwing and losing which tokens survived.
  it('reports per message when a batch partially fails', async () => {
    respondWith({
      data: [
        { status: 'ok', id: '1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      ],
    });
    expect(await provider().send([message('a'), message('b')])).toEqual([
      { token: 'a', ok: true },
      { token: 'b', ok: false, error: 'DEVICE_NOT_REGISTERED' },
    ]);
  });

  it('treats a non-2xx response as transient for the whole batch', async () => {
    respondWith({ errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }, 500);
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'TRANSIENT' },
    ]);
  });

  it('treats a network failure as transient rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'TRANSIENT' },
    ]);
  });

  it('splits batches larger than Expo accepts', async () => {
    const spy = respondWith({ data: Array.from({ length: 100 }, () => ({ status: 'ok', id: '1' })) });
    const messages = Array.from({ length: 150 }, (_, i) => message(`t${i}`));
    const results = await provider().send(messages);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(150);
  });

  it('sends no request for an empty batch', async () => {
    const spy = respondWith({ data: [] });
    expect(await provider().send([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test:unit -- push.provider`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the port**

Create `src/modules/notifications/push-provider.ts`:

```ts
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/**
 * Three outcomes, because each demands different handling:
 *   DEVICE_NOT_REGISTERED — the app was uninstalled; reap the token.
 *   TRANSIENT             — retry the job.
 *   INVALID               — our fault; retrying cannot help.
 */
export type PushFailure = 'DEVICE_NOT_REGISTERED' | 'TRANSIENT' | 'INVALID';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** Carried to the client so tapping the notification opens the right screen. */
  data?: Record<string, string>;
}

export interface PushResult {
  token: string;
  ok: boolean;
  error?: PushFailure;
}

/**
 * The transport boundary, and deliberately one method.
 *
 * It returns per-message results rather than throwing: a batch routinely
 * succeeds partially, and a thrown error would lose which tokens survived.
 */
export interface PushProvider {
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

/**
 * Thrown inside the push processor purely to make BullMQ retry. It is not a
 * DomainError: nothing here ever reaches an HTTP client, so it has no place in
 * the client-facing error contract.
 */
export class PushSendError extends Error {}
```

- [ ] **Step 4: Write the fake adapter**

Create `src/modules/notifications/fake-push.provider.ts`:

```ts
import { Logger } from '@nestjs/common';
import type { PushFailure, PushMessage, PushProvider, PushResult } from './push-provider';

/**
 * Records notifications instead of sending them. Integration and e2e suites
 * read `sent` back, so the whole path — enqueue, resolve, render, send — runs
 * rather than being mocked away, exactly as FakeSmsProvider carries the OTP
 * tests.
 */
export class FakePushProvider implements PushProvider {
  private readonly logger = new Logger(FakePushProvider.name);

  readonly sent: PushMessage[] = [];
  failNextWith: PushFailure | undefined;

  send(messages: PushMessage[]): Promise<PushResult[]> {
    const failure = this.failNextWith;
    if (failure) {
      this.failNextWith = undefined;
      return Promise.resolve(messages.map((m) => ({ token: m.token, ok: false, error: failure })));
    }

    this.sent.push(...messages);
    if (process.env.NODE_ENV !== 'test') {
      for (const m of messages) {
        this.logger.log(`[fake push] ${m.token}: ${m.title} — ${m.body}`);
      }
    }
    return Promise.resolve(messages.map((m) => ({ token: m.token, ok: true })));
  }

  reset(): void {
    this.sent.length = 0;
    this.failNextWith = undefined;
  }
}
```

- [ ] **Step 5: Write the Expo adapter**

Create `src/modules/notifications/expo-push.provider.ts`:

```ts
import { Logger } from '@nestjs/common';
import type { PushFailure, PushMessage, PushProvider, PushResult } from './push-provider';

const ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** Expo rejects larger batches outright. */
const MAX_BATCH = 100;

interface ExpoTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

/**
 * Maps Expo's ticket vocabulary onto ours. Anything unrecognised is treated as
 * transient: retrying a handful of times is cheaper than silently dropping a
 * notification because Expo added an error code we had not seen.
 */
function classify(detail: string | undefined): PushFailure {
  switch (detail) {
    case 'DeviceNotRegistered':
      return 'DEVICE_NOT_REGISTERED';
    case 'MessageTooBig':
    case 'InvalidCredentials':
      return 'INVALID';
    default:
      return 'TRANSIENT';
  }
}

export class ExpoPushProvider implements PushProvider {
  private readonly logger = new Logger(ExpoPushProvider.name);

  constructor(private readonly accessToken: string | undefined) {}

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH) {
      results.push(...(await this.sendBatch(messages.slice(i, i + MAX_BATCH))));
    }
    return results;
  }

  private async sendBatch(batch: PushMessage[]): Promise<PushResult[]> {
    const allTransient = (): PushResult[] =>
      batch.map((m) => ({ token: m.token, ok: false, error: 'TRANSIENT' as const }));

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(
          batch.map((m) => ({ to: m.token, title: m.title, body: m.body, data: m.data })),
        ),
      });
    } catch (cause) {
      this.logger.warn(`push transport unreachable: ${String(cause)}`);
      return allTransient();
    }

    if (!response.ok) {
      this.logger.warn(`push transport returned ${response.status}`);
      return allTransient();
    }

    const payload = (await response.json()) as { data?: ExpoTicket[] };
    const tickets = payload.data ?? [];

    return batch.map((m, index) => {
      const ticket = tickets[index];
      // A missing ticket means the response did not line up with the request;
      // retrying is the safe reading.
      if (!ticket) return { token: m.token, ok: false, error: 'TRANSIENT' as const };
      if (ticket.status === 'ok') return { token: m.token, ok: true };
      return { token: m.token, ok: false, error: classify(ticket.details?.error) };
    });
  }
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm test:unit -- push.provider`
Expected: PASS, 14 tests.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
git add src/modules/notifications/push-provider.ts src/modules/notifications/fake-push.provider.ts src/modules/notifications/fake-push.provider.spec.ts src/modules/notifications/expo-push.provider.ts src/modules/notifications/expo-push.provider.spec.ts
git commit -m "feat: PushProvider port with Expo and fake adapters

send() returns per-message results instead of throwing, because a batch
routinely fails partially and an exception would lose which tokens survived.
Unrecognised Expo error codes classify as transient: retrying a few times is
cheaper than dropping a notification because the vendor added a code."
```

---

## Task 4: Push templates

**Files:**
- Create: `src/modules/notifications/push-templates.ts`
- Create: `src/modules/notifications/push-templates.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PushTemplateKey = 'SESSION_STARTING' | 'CUSTOMER_READY'`
  - `interface PushContent { title: string; body: string }`
  - `renderPush(key: PushTemplateKey, locale: string): PushContent`
  - `PUSH_TEMPLATES` (exported for the spec's coverage assertion)

- [ ] **Step 1: Write the failing unit test**

Create `src/modules/notifications/push-templates.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PUSH_TEMPLATES, renderPush, type PushTemplateKey } from './push-templates';

const KEYS = Object.keys(PUSH_TEMPLATES) as PushTemplateKey[];
const LOCALES = ['en', 'he'];

describe('push templates', () => {
  it.each(KEYS)('%s is defined in every supported locale', (key) => {
    for (const locale of LOCALES) {
      const content = renderPush(key, locale);
      expect(content.title.length).toBeGreaterThan(0);
      expect(content.body.length).toBeGreaterThan(0);
    }
  });

  // Guards the phase-4 templates, which will interpolate: a missing parameter
  // must not ship a literal placeholder to a customer's lock screen.
  it.each(KEYS)('%s leaves no unsubstituted placeholder', (key) => {
    for (const locale of LOCALES) {
      const { title, body } = renderPush(key, locale);
      expect(`${title} ${body}`).not.toMatch(/[{}]/);
    }
  });

  it('falls back to English for an unknown locale', () => {
    expect(renderPush('SESSION_STARTING', 'fr')).toEqual(renderPush('SESSION_STARTING', 'en'));
  });

  it('renders Hebrew differently from English', () => {
    expect(renderPush('SESSION_STARTING', 'he')).not.toEqual(renderPush('SESSION_STARTING', 'en'));
  });

  it('keeps titles short enough for a lock screen', () => {
    for (const key of KEYS) {
      for (const locale of LOCALES) {
        expect(renderPush(key, locale).title.length).toBeLessThanOrEqual(40);
      }
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit -- push-templates`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the templates**

Create `src/modules/notifications/push-templates.ts`:

```ts
export type PushTemplateKey = 'SESSION_STARTING' | 'CUSTOMER_READY';

export interface PushContent {
  title: string;
  body: string;
}

/**
 * Developer-owned strings, so they live in code rather than the database —
 * the same split as OTP_TEMPLATES.
 *
 * A push is the documented exception to the rule that the server never
 * pre-resolves a locale: the text is delivered by the OS, so the client cannot
 * localize it after the fact. `users.preferred_locale` decides which one.
 *
 * No interpolation yet — neither notification carries a variable. Phase 4's
 * PROMO_READY is the first that will, and the spec's placeholder test is
 * already here waiting for it.
 */
export const PUSH_TEMPLATES: Record<PushTemplateKey, Record<string, PushContent>> = {
  SESSION_STARTING: {
    en: { title: 'Your session starts now', body: 'Tap to confirm you are ready to film.' },
    he: { title: 'הצילום שלך מתחיל עכשיו', body: 'הקישו כדי לאשר שאתם מוכנים.' },
  },
  CUSTOMER_READY: {
    en: { title: 'Customer is ready', body: 'They confirmed they are at the location.' },
    he: { title: 'הלקוח מוכן', body: 'התקבל אישור שהלקוח נמצא במקום.' },
  },
};

export function renderPush(key: PushTemplateKey, locale: string): PushContent {
  const byLocale = PUSH_TEMPLATES[key];
  return byLocale[locale] ?? byLocale.en!;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm test:unit -- push-templates`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
git add src/modules/notifications/push-templates.ts src/modules/notifications/push-templates.spec.ts
git commit -m "feat: locale-keyed push notification templates

A push is the one place the server resolves a locale, because the OS renders
the text and the client cannot localize it afterwards. Templates carry no
parameters yet; the placeholder assertion is in place for phase 4."
```

---

## Task 5: Queue infrastructure

**Files:**
- Create: `src/infra/queue/queue.constants.ts`
- Create: `src/infra/queue/queue.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `AppConfig`, `requireEnv`.
- Produces:
  - `PUSH_QUEUE = 'push'`, `SCHEDULER_QUEUE = 'scheduler'`, `PUSH_JOB = 'send-push'`, `TICK_JOB = 'tick'`, `TICK_SCHEDULER_ID = 'readiness-tick'`
  - `QUEUE_CONNECTION: symbol` — an `IORedis` instance configured for BullMQ
  - `PUSH_QUEUE_TOKEN: symbol` — a BullMQ `Queue`
  - `QueueModule` (`@Global`)

- [ ] **Step 1: Write the constants**

Create `src/infra/queue/queue.constants.ts`:

```ts
export const PUSH_QUEUE = 'push';
export const SCHEDULER_QUEUE = 'scheduler';

export const PUSH_JOB = 'send-push';
export const TICK_JOB = 'tick';

/**
 * Stable id for the repeatable tick. Keyed by id, upsertJobScheduler replaces
 * its own schedule when the interval changes — with the older
 * queue.add({ repeat }) API, changing SCHEDULER_TICK_SEC would leave the
 * previous schedule registered and the tick would silently run twice.
 */
export const TICK_SCHEDULER_ID = 'readiness-tick';

export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');
export const PUSH_QUEUE_TOKEN = Symbol('PUSH_QUEUE_TOKEN');

export interface PushJobData {
  userId: string;
  key: string;
  data: Record<string, string>;
}
```

- [ ] **Step 2: Write the module**

Create `src/infra/queue/queue.module.ts`:

```ts
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { requireEnv, type AppConfig } from '../config/typed-config';
import { PUSH_QUEUE, PUSH_QUEUE_TOKEN, QUEUE_CONNECTION } from './queue.constants';

@Global()
@Module({
  providers: [
    {
      provide: QUEUE_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: AppConfig) =>
        new IORedis(requireEnv(config, 'REDIS_URL'), {
          // Mandatory for BullMQ, and the reason this cannot share the REDIS
          // provider in infra/redis: that one sets maxRetriesPerRequest to 2,
          // which aborts the long blocking reads BullMQ's workers depend on.
          maxRetriesPerRequest: null,
        }),
    },
    {
      provide: PUSH_QUEUE_TOKEN,
      inject: [QUEUE_CONNECTION, ConfigService],
      useFactory: (connection: IORedis, config: AppConfig) =>
        new Queue(PUSH_QUEUE, { connection, prefix: requireEnv(config, 'QUEUE_PREFIX') }),
    },
  ],
  exports: [QUEUE_CONNECTION, PUSH_QUEUE_TOKEN],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Inject(PUSH_QUEUE_TOKEN) private readonly pushQueue: Queue,
    @Inject(QUEUE_CONNECTION) private readonly connection: IORedis,
  ) {}

  // Queue before connection: closing the connection first leaves the queue's
  // in-flight commands to fail rather than drain.
  async onApplicationShutdown() {
    await this.pushQueue.close();
    await this.connection.quit();
  }
}
```

- [ ] **Step 3: Wire it into the API module**

In `src/app.module.ts`, add the import and list it after `RedisModule`:

```ts
import { QueueModule } from './infra/queue/queue.module';
```

```ts
    RedisModule,
    QueueModule,
```

- [ ] **Step 4: Verify the app still boots and closes cleanly**

Run: `pnpm typecheck && pnpm lint && pnpm test:integration -- health`
Expected: PASS, and the process exits rather than hanging — a hang means the queue connection is not being closed on `app.close()`.

- [ ] **Step 5: Commit**

```bash
git add src/infra/queue/ src/app.module.ts
git commit -m "feat: BullMQ connection and push queue producer

BullMQ needs its own ioredis client: it requires maxRetriesPerRequest null and
the shared REDIS provider sets 2, which would abort the blocking reads workers
depend on. Shutdown closes the queue before the connection so in-flight
commands drain instead of failing."
```

---

## Task 6: NotificationsService and the push processor

**Files:**
- Create: `src/modules/notifications/notifications.service.ts`
- Create: `src/modules/notifications/notifications.module.ts`
- Create: `src/modules/notifications/push.processor.ts`
- Create: `src/modules/notifications/notifications.worker.module.ts`
- Test: `test/integration/push-processor.spec.ts`

**Interfaces:**
- Consumes: `PUSH_QUEUE_TOKEN`, `PushJobData`, `DevicesRepository`, `UsersRepository.findById`, `PUSH_PROVIDER`, `renderPush`.
- Produces:
  - `NotificationsService.notify(userId: string, key: PushTemplateKey, data?: Record<string, string>): Promise<void>`
  - `PushProcessor.handle(payload: PushJobData): Promise<void>` — public so tests drive it without a live worker
  - `NotificationsModule` exports `NotificationsService`, `DevicesRepository`, `PUSH_PROVIDER`
  - `NotificationsWorkerModule` declares `PushProcessor`

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/push-processor.spec.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { users } from '../../src/infra/db/schema';
import { UsersModule } from '../../src/modules/users/users.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { NotificationsWorkerModule } from '../../src/modules/notifications/notifications.worker.module';
import { QueueModule } from '../../src/infra/queue/queue.module';
import { PushProcessor } from '../../src/modules/notifications/push.processor';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { PUSH_PROVIDER } from '../../src/modules/notifications/push-provider';
import type { FakePushProvider } from '../../src/modules/notifications/fake-push.provider';
import { getTestDb } from './db.helper';

const db = getTestDb();

let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let processor: PushProcessor;
let devices: DevicesRepository;
let push: FakePushProvider;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      DrizzleModule,
      QueueModule,
      UsersModule,
      NotificationsModule,
      NotificationsWorkerModule,
    ],
  }).compile();
  await moduleRef.init();

  processor = moduleRef.get(PushProcessor);
  devices = moduleRef.get(DevicesRepository);
  push = moduleRef.get<FakePushProvider>(PUSH_PROVIDER);
});

afterAll(async () => {
  await moduleRef?.close();
});

async function makeCustomer(locale: string) {
  const id = uuidv7();
  await db
    .insert(users)
    .values({ id, role: 'customer', phone: `+9725${Date.now() % 100000000}`, preferredLocale: locale });
  return id;
}

beforeEach(() => {
  push.reset();
});

describe('push processor', () => {
  it('renders in the user preferred locale and sends to every active device', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-a', 'ios');
    await devices.register(userId, 'tok-b', 'android');

    await processor.handle({ userId, key: 'SESSION_STARTING', data: { bookingId: 'b1' } });

    expect(push.sent).toHaveLength(2);
    expect(push.sent.map((m) => m.token).sort()).toEqual(['tok-a', 'tok-b']);
    expect(push.sent[0]!.title).toBe('הצילום שלך מתחיל עכשיו');
    // Carried through so tapping the notification opens the right booking.
    expect(push.sent[0]!.data).toEqual({ bookingId: 'b1' });
  });

  it('renders English for an English user', async () => {
    const userId = await makeCustomer('en');
    await devices.register(userId, 'tok-en', 'ios');

    await processor.handle({ userId, key: 'SESSION_STARTING', data: {} });

    expect(push.sent[0]!.title).toBe('Your session starts now');
  });

  // Not an error: the user has not installed the app or declined permission.
  it('completes without sending when the user has no devices', async () => {
    const userId = await makeCustomer('he');
    await expect(
      processor.handle({ userId, key: 'SESSION_STARTING', data: {} }),
    ).resolves.toBeUndefined();
    expect(push.sent).toEqual([]);
  });

  it('completes quietly for a user that no longer exists', async () => {
    await expect(
      processor.handle({ userId: uuidv7(), key: 'SESSION_STARTING', data: {} }),
    ).resolves.toBeUndefined();
  });

  // Without reaping, dead tokens accumulate permanently and every later send
  // does provably wasted work.
  it('revokes a token the transport reports as unregistered', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-dead', 'ios');
    push.failNextWith = 'DEVICE_NOT_REGISTERED';

    await processor.handle({ userId, key: 'SESSION_STARTING', data: {} });

    expect(await devices.listActiveFor(userId)).toEqual([]);
  });

  it('does not send to a reaped token on the next notification', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-dead', 'ios');
    push.failNextWith = 'DEVICE_NOT_REGISTERED';
    await processor.handle({ userId, key: 'SESSION_STARTING', data: {} });

    push.reset();
    await processor.handle({ userId, key: 'SESSION_STARTING', data: {} });
    expect(push.sent).toEqual([]);
  });

  it('throws on a transient failure so BullMQ retries', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-flaky', 'ios');
    push.failNextWith = 'TRANSIENT';

    await expect(processor.handle({ userId, key: 'SESSION_STARTING', data: {} })).rejects.toThrow();
    // A transient failure says nothing about the token, so it must survive.
    expect(await devices.listActiveFor(userId)).toEqual(['tok-flaky']);
  });

  it('does not throw on an invalid message, which retrying cannot fix', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-invalid', 'ios');
    push.failNextWith = 'INVALID';

    await expect(
      processor.handle({ userId, key: 'SESSION_STARTING', data: {} }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- push-processor`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the producer service**

Create `src/modules/notifications/notifications.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PUSH_JOB, PUSH_QUEUE_TOKEN } from '../../infra/queue/queue.constants';
import type { PushTemplateKey } from './push-templates';

@Injectable()
export class NotificationsService {
  constructor(@Inject(PUSH_QUEUE_TOKEN) private readonly queue: Queue) {}

  /**
   * `data` is the push payload delivered to the client, not template
   * parameters — neither template interpolates anything, but the app needs the
   * booking id to open the right screen when the notification is tapped.
   *
   * The job carries ids only. Device tokens and locale are resolved in the
   * processor at send time, so a job retried after a backoff cannot push to a
   * token revoked in the meantime.
   */
  async notify(
    userId: string,
    key: PushTemplateKey,
    data: Record<string, string> = {},
  ): Promise<void> {
    await this.queue.add(
      PUSH_JOB,
      { userId, key, data },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
  }
}
```

- [ ] **Step 4: Write the producer module**

Create `src/modules/notifications/notifications.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import { DevicesRepository } from './devices.repository';
import { NotificationsService } from './notifications.service';
import { ExpoPushProvider } from './expo-push.provider';
import { FakePushProvider } from './fake-push.provider';
import { PUSH_PROVIDER, type PushProvider } from './push-provider';

/**
 * The single place a push vendor is chosen, mirroring SmsModule. Adding FCM
 * means one more class and one more case here; nothing that sends changes.
 */
@Module({
  providers: [
    DevicesRepository,
    NotificationsService,
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: AppConfig): PushProvider => {
        const name = requireEnv(config, 'PUSH_PROVIDER');
        switch (name) {
          case 'expo':
            return new ExpoPushProvider(config.get('EXPO_ACCESS_TOKEN', { infer: true }));
          case 'fake':
            return new FakePushProvider();
          default:
            // Fail at boot, not on the first notification.
            throw new Error(`Unknown PUSH_PROVIDER: ${String(name)}`);
        }
      },
    },
  ],
  exports: [NotificationsService, DevicesRepository, PUSH_PROVIDER],
})
export class NotificationsModule {}
```

- [ ] **Step 5: Write the processor**

Create `src/modules/notifications/push.processor.ts`:

```ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import {
  PUSH_QUEUE,
  QUEUE_CONNECTION,
  type PushJobData,
} from '../../infra/queue/queue.constants';
import { UsersRepository } from '../users/users.repository';
import { DevicesRepository } from './devices.repository';
import { renderPush, type PushTemplateKey } from './push-templates';
import { PUSH_PROVIDER, PushSendError, type PushProvider } from './push-provider';

@Injectable()
export class PushProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PushProcessor.name);
  private worker: Worker | undefined;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: IORedis,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    @Inject(ConfigService) private readonly config: AppConfig,
    private readonly devices: DevicesRepository,
    private readonly users: UsersRepository,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(PUSH_QUEUE, (job) => this.handle(job.data as PushJobData), {
      connection: this.connection,
      prefix: requireEnv(this.config, 'QUEUE_PREFIX'),
      concurrency: requireEnv(this.config, 'WORKER_CONCURRENCY'),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  /**
   * Public so tests can drive the whole path without a live worker loop.
   *
   * Resolution happens here rather than at enqueue time: a job retried after a
   * backoff must not push to a token revoked in the interim.
   */
  async handle(payload: PushJobData): Promise<void> {
    const user = await this.users.findById(payload.userId);
    if (!user) {
      // The account was deleted between enqueue and send. Nothing to do, and
      // retrying will never help.
      return;
    }

    const tokens = await this.devices.listActiveFor(payload.userId);
    // Not an error: the user has not installed the app, or declined permission.
    if (tokens.length === 0) return;

    const content = renderPush(payload.key as PushTemplateKey, user.preferredLocale);
    const results = await this.push.send(
      tokens.map((token) => ({ token, ...content, data: payload.data })),
    );

    const dead = results
      .filter((r) => r.error === 'DEVICE_NOT_REGISTERED')
      .map((r) => r.token);
    if (dead.length > 0) {
      this.logger.log(`revoking ${dead.length} unregistered device token(s)`);
      await this.devices.revokeTokens(dead);
    }

    // INVALID deliberately does not throw: the message is malformed and no
    // number of retries will change that.
    if (results.some((r) => r.error === 'TRANSIENT')) {
      throw new PushSendError(`push transport failed for ${payload.key}`);
    }
  }
}
```

- [ ] **Step 6: Write the worker-side module**

Create `src/modules/notifications/notifications.worker.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from './notifications.module';
import { PushProcessor } from './push.processor';

/**
 * Processors live only here, never in NotificationsModule. That is what makes
 * it structurally impossible for the API process to start consuming jobs — a
 * runtime flag would eventually be set wrong in one environment.
 */
@Module({
  imports: [NotificationsModule, UsersModule],
  providers: [PushProcessor],
  exports: [PushProcessor],
})
export class NotificationsWorkerModule {}
```

- [ ] **Step 7: Confirm `UsersModule` exports its repository**

Read `src/modules/users/users.module.ts`. If `UsersRepository` is not in `exports`, add it — `PushProcessor` injects it.

- [ ] **Step 8: Run the tests and watch them pass**

Run: `pnpm test:integration -- push-processor`
Expected: PASS, 8 tests.

- [ ] **Step 9: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add src/modules/notifications/notifications.service.ts src/modules/notifications/notifications.module.ts src/modules/notifications/push.processor.ts src/modules/notifications/notifications.worker.module.ts src/modules/users/users.module.ts test/integration/push-processor.spec.ts
git commit -m "feat: notification producer and push processor

The job carries ids only; tokens and locale resolve in the processor at send
time, so a job retried after a backoff cannot push to a token revoked in the
interim. DEVICE_NOT_REGISTERED reaps the token, TRANSIENT throws to retry, and
INVALID does neither because retrying a malformed message cannot help.

Processors are declared only in the worker module, so no configuration can make
the API process consume jobs."
```

---

## Task 7: Device registration endpoints

**Files:**
- Create: `src/modules/notifications/dto/device.dto.ts`
- Create: `src/modules/notifications/devices.controller.ts`
- Modify: `src/modules/notifications/notifications.module.ts`
- Modify: `src/common/errors/error-codes.ts`
- Modify: `src/app.module.ts`
- Modify: `test/e2e/authz-matrix.spec.ts`
- Test: `test/e2e/devices.spec.ts`

**Interfaces:**
- Consumes: `DevicesRepository`, `@CurrentUser`, `@Roles`, `NotFoundError`, `ErrorCodes`.
- Produces: `POST /me/devices` (200), `POST /me/devices/revoke` (200), `ErrorCodes.DEVICE_NOT_FOUND`.

- [ ] **Step 1: Write the failing e2e test**

Create `test/e2e/devices.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { users } from '../../src/infra/db/schema';
import { getTestDb } from '../integration/db.helper';

const db = getTestDb();

let app: TestApp;
let tokens: TokenService;
let devices: DevicesRepository;

beforeAll(async () => {
  app = await createTestApp();
  tokens = app.app.get(TokenService);
  devices = app.app.get(DevicesRepository);
});
afterAll(async () => {
  await app?.close();
});

async function customerWithToken() {
  const id = uuidv7();
  await db
    .insert(users)
    .values({ id, role: 'customer', phone: `+9725${String(Date.now()).slice(-8)}`, preferredLocale: 'he' });
  const jwt = tokens.issueAccessToken({ sub: id, role: 'customer', jti: uuidv7() });
  return { id, jwt };
}

const PUSH_TOKEN = 'ExponentPushToken[cccccccccccccccccccccc]';

describe('POST /me/devices', () => {
  it('registers a token and answers 200, not 201', async () => {
    const { id, jwt } = await customerWithToken();
    const res = await request(app.server)
      .post('/me/devices')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN, platform: 'ios' });

    // 200: repeat registration updates rather than creates, so this route
    // does not genuinely create a resource every time.
    expect(res.status).toBe(200);
    expect(await devices.listActiveFor(id)).toEqual([PUSH_TOKEN]);
  });

  it('is idempotent across repeated registrations', async () => {
    const { id, jwt } = await customerWithToken();
    const agent = request(app.server);
    await agent.post('/me/devices').set('Authorization', `Bearer ${jwt}`).send({ token: PUSH_TOKEN, platform: 'ios' });
    await request(app.server)
      .post('/me/devices')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN, platform: 'ios' });

    expect(await devices.listActiveFor(id)).toEqual([PUSH_TOKEN]);
  });

  it('rejects a missing platform with 422', async () => {
    const { jwt } = await customerWithToken();
    const res = await request(app.server)
      .post('/me/devices')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an empty token with 422', async () => {
    const { jwt } = await customerWithToken();
    const res = await request(app.server)
      .post('/me/devices')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: '', platform: 'ios' });
    expect(res.status).toBe(422);
  });
});

describe('POST /me/devices/revoke', () => {
  it('revokes a token the caller holds', async () => {
    const { id, jwt } = await customerWithToken();
    await devices.register(id, PUSH_TOKEN, 'ios');

    const res = await request(app.server)
      .post('/me/devices/revoke')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN });

    expect(res.status).toBe(200);
    expect(await devices.listActiveFor(id)).toEqual([]);
  });

  // Deliberately not a silent success: a client revoking a token it does not
  // hold has a bookkeeping bug worth surfacing, and nothing leaks because the
  // caller already presented the token.
  it('answers 404 for a token the caller does not hold', async () => {
    const other = await customerWithToken();
    await devices.register(other.id, PUSH_TOKEN, 'ios');
    const { jwt } = await customerWithToken();

    const res = await request(app.server)
      .post('/me/devices/revoke')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
    expect(await devices.listActiveFor(other.id)).toEqual([PUSH_TOKEN]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- devices.spec`
Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Add the error code**

In `src/common/errors/error-codes.ts`, add after the `ACTOR_NOT_PERMITTED` line:

```ts

  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
```

- [ ] **Step 4: Write the DTOs**

Create `src/modules/notifications/dto/device.dto.ts`:

```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Deliberately loose on shape: an Expo token is `ExponentPushToken[...]`, but a
// bare-workflow development build registers a raw FCM or APNs token instead,
// and rejecting those would be a puzzling failure to debug from the client.
const pushToken = z.string().min(1).max(200);

export const registerDeviceSchema = z.object({
  token: pushToken,
  platform: z.enum(['ios', 'android']),
});

export const revokeDeviceSchema = z.object({
  token: pushToken,
});

export class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}
export class RevokeDeviceDto extends createZodDto(revokeDeviceSchema) {}
```

- [ ] **Step 5: Write the controller**

Create `src/modules/notifications/devices.controller.ts`:

```ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { NotFoundError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DevicesRepository } from './devices.repository';
import { RegisterDeviceDto, RevokeDeviceDto } from './dto/device.dto';

@ApiBearerAuth()
@Roles('customer', 'operator', 'admin')
@Controller('me/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesRepository) {}

  // 200 rather than 201: the client re-registers on every foreground because
  // the OS may rotate the token between launches, so this usually updates.
  @Post()
  @HttpCode(200)
  async register(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto) {
    await this.devices.register(user.userId, dto.token, dto.platform);
    return { registered: true };
  }

  // A POST carrying the token in the body rather than DELETE /me/devices/:token:
  // an Expo token is shaped `ExponentPushToken[...]`, and those brackets would
  // have to survive percent-encoding through every client, proxy and log.
  @Post('revoke')
  @HttpCode(200)
  async revoke(@CurrentUser() user: AuthenticatedUser, @Body() dto: RevokeDeviceDto) {
    const revoked = await this.devices.revoke(user.userId, dto.token);
    if (!revoked) {
      throw new NotFoundError(ErrorCodes.DEVICE_NOT_FOUND, 'No such active device for this user.');
    }
    return { revoked: true };
  }
}
```

- [ ] **Step 6: Register the controller and the module**

In `src/modules/notifications/notifications.module.ts`, add the import and the `controllers` entry:

```ts
import { DevicesController } from './devices.controller';
```

```ts
@Module({
  controllers: [DevicesController],
  providers: [
```

In `src/app.module.ts`, add the import and list it after `BookingsModule`:

```ts
import { NotificationsModule } from './modules/notifications/notifications.module';
```

```ts
    BookingsModule,
    NotificationsModule,
```

- [ ] **Step 7: Add the authorization matrix rows**

In `test/e2e/authz-matrix.spec.ts`, add before the maintenance row:

```ts
  {
    method: 'post',
    path: '/me/devices',
    allow: ['customer', 'operator', 'admin'],
    body: { token: 'ExponentPushToken[matrix]', platform: 'ios' },
  },
  {
    method: 'post',
    path: '/me/devices/revoke',
    allow: ['customer', 'operator', 'admin'],
    body: { token: 'ExponentPushToken[matrix]' },
  },
```

And update the count assertion:

```ts
    expect(PROTECTED_ROUTES).toHaveLength(26);
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `pnpm test:integration -- devices.spec authz-matrix`
Expected: PASS.

- [ ] **Step 9: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add src/modules/notifications/dto/ src/modules/notifications/devices.controller.ts src/modules/notifications/notifications.module.ts src/common/errors/error-codes.ts src/app.module.ts test/e2e/devices.spec.ts test/e2e/authz-matrix.spec.ts
git commit -m "feat: device registration endpoints

Revocation is a POST with the token in the body rather than a path parameter:
an Expo token carries brackets that would have to survive percent-encoding
through every client, proxy and log. Revoking a token the caller does not hold
is a 404 rather than a silent success, because it signals a client bookkeeping
bug and leaks nothing the caller did not already send."
```

---

## Task 8: `bookings.start_notified_at`

**Files:**
- Modify: `src/infra/db/schema/bookings.ts`
- Create: migration under `drizzle/`

**Interfaces:**
- Consumes: nothing.
- Produces: `bookings.startNotifiedAt: Date | null`, index `bookings_start_notify_idx`.

- [ ] **Step 1: Add the column and index**

In `src/infra/db/schema/bookings.ts`, add to the column list after `readyAckAt`:

```ts
    // Both the idempotency record and the claim token for the readiness scan:
    // the UPDATE that reads it also sets it, so two workers cannot both notify.
    startNotifiedAt: timestamp('start_notified_at', { withTimezone: true }),
```

And add to the index array, after `customer_one_booking_per_tick`:

```ts
    // Partial, so a row leaves the index the moment it is notified: the scan
    // reads the pending set rather than the table, however large it grows.
    // Bare column names — a table-qualified reference is invalid in
    // CREATE INDEX ... WHERE.
    index('bookings_start_notify_idx')
      .on(t.startAt)
      .where(sql`status = 'confirmed' AND start_notified_at IS NULL`),
```

- [ ] **Step 2: Generate and inspect the migration**

```bash
pnpm migrate:generate
```

Open the generated `drizzle/0005_*.sql`. Confirm the index predicate uses bare column names. Fix by hand if not.

```bash
pnpm migrate
```

- [ ] **Step 3: Verify the schema applies cleanly**

Run: `pnpm typecheck && pnpm test:integration -- schema-slots`
Expected: PASS — the migration applied without error during suite setup.

- [ ] **Step 4: Commit**

```bash
git add src/infra/db/schema/bookings.ts drizzle/
git commit -m "feat: start_notified_at claim column on bookings

Partial index on the pending set only, so the readiness scan reads a handful of
rows regardless of how large bookings grows."
```

---

## Task 9: The readiness claim scan

**Files:**
- Create: `src/modules/scheduling/readiness.repository.ts`
- Test: `test/integration/readiness-scan.spec.ts`

**Interfaces:**
- Consumes: `DRIZZLE`/`Db`, `AppConfig`, `requireEnv`.
- Produces: `ReadinessRepository.claimDueForStartNotification(now: Date): Promise<Array<{ id: string; customerId: string }>>`

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/readiness-scan.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { ReadinessRepository } from '../../src/modules/scheduling/readiness.repository';
import { bookings } from '../../src/infra/db/schema';
import { getTestDb } from './db.helper';
import { seedBookableBooking } from './booking.fixture';

const db = getTestDb();

let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let repo: ReadinessRepository;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule, DrizzleModule],
    providers: [ReadinessRepository],
  }).compile();
  repo = moduleRef.get(ReadinessRepository);
});
afterAll(async () => {
  await moduleRef?.close();
});

const NOW = new Date('2026-09-16T12:00:00.000Z');
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe('readiness claim scan', () => {
  it('claims a confirmed booking whose start has just passed', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(1), status: 'confirmed' });

    const claimed = await repo.claimDueForStartNotification(NOW);

    expect(claimed).toEqual([{ id: booking.id, customerId: booking.customerId }]);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.startNotifiedAt).not.toBeNull();
  });

  it('does not claim a booking whose start is still in the future', async () => {
    await seedBookableBooking({ startAt: new Date(NOW.getTime() + 60_000), status: 'confirmed' });
    expect(await repo.claimDueForStartNotification(NOW)).toEqual([]);
  });

  it('claims each booking exactly once', async () => {
    await seedBookableBooking({ startAt: minutesBefore(1), status: 'confirmed' });

    expect(await repo.claimDueForStartNotification(NOW)).toHaveLength(1);
    expect(await repo.claimDueForStartNotification(NOW)).toEqual([]);
  });

  /**
   * The analogue of booking-concurrency.spec.ts. Under READ COMMITTED the
   * second UPDATE blocks on the row lock, then re-evaluates its predicate
   * against the committed version and finds start_notified_at no longer null.
   * If the claim is ever split into a SELECT then an UPDATE, this fails — and
   * duplicate pushes are a bug users report rather than monitoring.
   */
  it('sends exactly one notification under two concurrent ticks', async () => {
    await seedBookableBooking({ startAt: minutesBefore(1), status: 'confirmed' });

    const [a, b] = await Promise.all([
      repo.claimDueForStartNotification(NOW),
      repo.claimDueForStartNotification(NOW),
    ]);

    expect(a.length + b.length).toBe(1);
  });

  it('ignores a booking that is already customer_ready', async () => {
    await seedBookableBooking({ startAt: minutesBefore(1), status: 'customer_ready' });
    expect(await repo.claimDueForStartNotification(NOW)).toEqual([]);
  });

  it.each(['in_progress', 'completed', 'cancelled', 'no_show', 'expired'] as const)(
    'ignores a %s booking',
    async (status) => {
      await seedBookableBooking({ startAt: minutesBefore(1), status });
      expect(await repo.claimDueForStartNotification(NOW)).toEqual([]);
    },
  );

  /**
   * After a worker outage the scan would otherwise announce "your session
   * starts now" for a session the sweep expires seconds later in the same tick.
   * The lower bound is the same SLOT_DURATION_MIN the sweep uses, so the two
   * scans partition the timeline with no gap and no overlap.
   */
  it('does not claim a booking whose window has fully elapsed', async () => {
    await seedBookableBooking({ startAt: minutesBefore(16), status: 'confirmed' });
    expect(await repo.claimDueForStartNotification(NOW)).toEqual([]);
  });

  it('still claims a booking one minute inside the window', async () => {
    await seedBookableBooking({ startAt: minutesBefore(14), status: 'confirmed' });
    expect(await repo.claimDueForStartNotification(NOW)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Write the shared booking fixture**

The suite above and Task 11's need the same seed. Create `test/integration/booking.fixture.ts`:

```ts
import { uuidv7 } from 'uuidv7';
import { sql } from 'drizzle-orm';
import {
  bookings,
  locationSessionTypes,
  locations,
  operatorCheckins,
  operatorSlots,
  operators,
  users,
} from '../../src/infra/db/schema';
import { getTestDb } from './db.helper';

type Status = 'confirmed' | 'customer_ready' | 'in_progress' | 'completed' | 'cancelled' | 'no_show' | 'expired';

let sequence = 0;

/**
 * A booking with every foreign key satisfied. Times are passed in rather than
 * derived from the clock, so a case can pin a booking to any point relative to
 * the scan's `now`.
 */
export async function seedBookableBooking(options: { startAt: Date; status: Status }) {
  const db = getTestDb();
  const n = ++sequence;

  const customerId = uuidv7();
  const operatorUserId = uuidv7();
  const operatorId = uuidv7();
  const locationId = uuidv7();
  const sessionTypeId = uuidv7();
  const checkinId = uuidv7();
  const slotId = uuidv7();
  const bookingId = uuidv7();

  await db.insert(users).values([
    { id: customerId, role: 'customer', phone: `+97250000${String(n).padStart(4, '0')}`, preferredLocale: 'he' },
    { id: operatorUserId, role: 'operator', email: `op${n}@example.com`, preferredLocale: 'en' },
  ]);
  await db.insert(operators).values({ id: operatorId, userId: operatorUserId, displayName: `Op ${n}` });

  const name = { en: `Loc ${n}`, he: `מיקום ${n}` };
  await db.insert(locations).values({
    id: locationId,
    code: `loc-${n}`,
    siteCode: `site-${n}`,
    siteName: name,
    name,
    geog: sql`ST_SetSRID(ST_MakePoint(34.78, 32.08), 4326)::geography`,
  });
  await db.insert(locationSessionTypes).values({
    id: sessionTypeId,
    locationId,
    code: `type-${n}`,
    name,
    price: '100.00',
    currency: 'ILS',
  });

  const windowStart = new Date(options.startAt.getTime() - 60 * 60_000);
  await db.insert(operatorCheckins).values({
    id: checkinId,
    operatorId,
    locationId,
    availableFrom: windowStart,
    availableUntil: new Date(options.startAt.getTime() + 60 * 60_000),
    checkedInGeog: sql`ST_SetSRID(ST_MakePoint(34.78, 32.08), 4326)::geography`,
  });
  await db.insert(operatorSlots).values({
    id: slotId,
    operatorId,
    locationId,
    checkinId,
    startAt: options.startAt,
    status: 'booked',
  });

  await db.insert(bookings).values({
    id: bookingId,
    operatorSlotId: slotId,
    customerId,
    operatorId,
    locationId,
    locationSessionTypeId: sessionTypeId,
    priceSnapshot: '100.00',
    currency: 'ILS',
    startAt: options.startAt,
    status: options.status,
  });

  return { id: bookingId, customerId, operatorId, operatorUserId, slotId, locationId };
}
```

If any column name above does not match the current schema, correct it against `src/infra/db/schema/` — the fixture must compile against the real tables, and `pnpm typecheck` covers `test/`.

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm test:integration -- readiness-scan`
Expected: FAIL — `ReadinessRepository` not found.

- [ ] **Step 4: Write the repository**

Create `src/modules/scheduling/readiness.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';

export interface DueForNotification {
  id: string;
  customerId: string;
}

@Injectable()
export class ReadinessRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  /**
   * Claim and record in one statement: the UPDATE that reads
   * `start_notified_at IS NULL` is the same one that sets it, so two worker
   * replicas cannot both notify — the second finds no matching row.
   *
   * The lower bound on `start_at` is not redundant. After a worker outage the
   * scan would otherwise announce "your session starts now" for a session the
   * sweep expires seconds later in the same tick. It uses the same
   * SLOT_DURATION_MIN as the sweep's grace, so the two partition the timeline
   * with no gap and no overlap.
   */
  async claimDueForStartNotification(now: Date): Promise<DueForNotification[]> {
    const slotMinutes = requireEnv(this.config, 'SLOT_DURATION_MIN');

    const result = await this.db.execute<{ id: string; customer_id: string }>(sql`
      UPDATE bookings
         SET start_notified_at = ${now}, updated_at = ${now}
       WHERE status = 'confirmed'
         AND start_notified_at IS NULL
         AND start_at <= ${now}
         AND start_at > ${now}::timestamptz - make_interval(mins => ${slotMinutes})
      RETURNING id, customer_id
    `);

    return result.rows.map((row) => ({ id: row.id, customerId: row.customer_id }));
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm test:integration -- readiness-scan`
Expected: PASS, 12 tests.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add src/modules/scheduling/readiness.repository.ts test/integration/readiness-scan.spec.ts test/integration/booking.fixture.ts
git commit -m "feat: readiness claim scan

Claim and record are one statement, so concurrent ticks cannot double-notify.
The lower bound on start_at stops a post-outage tick announcing a session the
sweep expires moments later; it reuses SLOT_DURATION_MIN so the scan and the
sweep partition the timeline exactly."
```

---

## Task 10: Operator acknowledgement

**Files:**
- Modify: `src/modules/bookings/domain/state-machine.ts`
- Modify: `src/modules/bookings/domain/state-machine.spec.ts`
- Modify: `src/modules/bookings/bookings.controller.ts`
- Modify: `test/e2e/authz-matrix.spec.ts`
- Test: `test/e2e/operator-ack.spec.ts`

**Interfaces:**
- Consumes: `transition`, `BookingsService.act`.
- Produces: `POST /bookings/:id/ack` accepts `operator` as well as `customer`.

- [ ] **Step 1: Update the state machine grid test**

In `src/modules/bookings/domain/state-machine.spec.ts`, add to the `ALLOWED` array immediately after the existing `CUSTOMER_ACK` row:

```ts
  ['confirmed', 'CUSTOMER_ACK', 'operator', 'customer_ready'],
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit -- state-machine`
Expected: FAIL — the new allowed row is rejected, and the grid-coverage assertion now sees 15 allowed against 154 forbidden.

- [ ] **Step 3: Widen the actor list**

In `src/modules/bookings/domain/state-machine.ts`, replace the `CUSTOMER_ACK` rule:

```ts
  // The operator may acknowledge on the customer's behalf: they are standing
  // next to them and are the best available evidence the customer showed up.
  // The event keeps its name — it records that the customer is present, and
  // the operator is a witness to that fact, not a second kind of event.
  CUSTOMER_ACK: {
    from: ['confirmed'],
    actors: ['customer', 'operator'],
    next: 'customer_ready',
    stampField: 'readyAckAt',
  },
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm test:unit -- state-machine`
Expected: PASS — 15 allowed, 153 forbidden, 168 total.

- [ ] **Step 5: Write the failing e2e test**

Create `test/e2e/operator-ack.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';
import { bookings } from '../../src/infra/db/schema';
import { getTestDb } from '../integration/db.helper';
import { seedBookableBooking } from '../integration/booking.fixture';

const db = getTestDb();

let app: TestApp;
let tokens: TokenService;

beforeAll(async () => {
  app = await createTestApp();
  tokens = app.app.get(TokenService);
});
afterAll(async () => {
  await app?.close();
});

const operatorJwt = (userId: string, operatorId: string) =>
  tokens.issueAccessToken({ sub: userId, role: 'operator', operatorId, jti: uuidv7() });

describe('operator acknowledgement', () => {
  it('lets the assigned operator acknowledge on the customer behalf', async () => {
    const booking = await seedBookableBooking({ startAt: new Date(), status: 'confirmed' });

    const res = await request(app.server)
      .post(`/bookings/${booking.id}/ack`)
      .set('Authorization', `Bearer ${operatorJwt(booking.operatorUserId, booking.operatorId)}`)
      .send({});

    expect(res.status).toBe(200);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.status).toBe('customer_ready');
    expect(row!.readyAckAt).not.toBeNull();
  });

  // The safety valve must not become a way to touch someone else's booking.
  it('refuses an operator who is not assigned to the booking', async () => {
    const booking = await seedBookableBooking({ startAt: new Date(), status: 'confirmed' });

    const res = await request(app.server)
      .post(`/bookings/${booking.id}/ack`)
      .set('Authorization', `Bearer ${operatorJwt(uuidv7(), uuidv7())}`)
      .send({});

    expect(res.status).toBe(403);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.status).toBe('confirmed');
  });

  it('still lets the customer acknowledge', async () => {
    const booking = await seedBookableBooking({ startAt: new Date(), status: 'confirmed' });

    const res = await request(app.server)
      .post(`/bookings/${booking.id}/ack`)
      .set(
        'Authorization',
        `Bearer ${tokens.issueAccessToken({ sub: booking.customerId, role: 'customer', jti: uuidv7() })}`,
      )
      .send({});

    expect(res.status).toBe(200);
  });

  it('refuses a second acknowledgement', async () => {
    const booking = await seedBookableBooking({ startAt: new Date(), status: 'customer_ready' });

    const res = await request(app.server)
      .post(`/bookings/${booking.id}/ack`)
      .set('Authorization', `Bearer ${operatorJwt(booking.operatorUserId, booking.operatorId)}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm test:integration -- operator-ack`
Expected: FAIL — 403, because the route is still `@Roles('customer')`.

- [ ] **Step 7: Widen the route**

In `src/modules/bookings/bookings.controller.ts`, replace the `ack` handler:

```ts
  // The operator is permitted so they can acknowledge on the customer's behalf
  // when the customer does not answer the session-start notification. Ownership
  // is unchanged: BookingsService.act still requires an operator caller to match
  // the booking's operator_id.
  @Roles('customer', 'operator')
  @Post(':id/ack')
  @HttpCode(200)
  ack(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'CUSTOMER_ACK', user.role, user);
  }
```

- [ ] **Step 8: Update the authorization matrix row**

In `test/e2e/authz-matrix.spec.ts`, change the `ack` row:

```ts
  { method: 'post', path: `/bookings/${uuidv7()}/ack`, allow: ['customer', 'operator'] },
```

The row count stays 26 — this widens an existing row rather than adding one.

- [ ] **Step 9: Run the tests and watch them pass**

Run: `pnpm test:unit && pnpm test:integration -- operator-ack authz-matrix booking-lifecycle`
Expected: PASS.

- [ ] **Step 10: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add src/modules/bookings/domain/state-machine.ts src/modules/bookings/domain/state-machine.spec.ts src/modules/bookings/bookings.controller.ts test/e2e/authz-matrix.spec.ts test/e2e/operator-ack.spec.ts
git commit -m "feat: operator may acknowledge readiness for the customer

The safety valve for the session-start notification: when the customer does not
answer, the operator standing next to them is the best available evidence they
showed up. The event keeps the name CUSTOMER_ACK because it records the
customer's presence; the operator is a witness, not a second kind of event.

Grid: 15 allowed, 153 rejected, still 168 cells."
```

---

## Task 11: The `sweepExpired` grace correction

This is a latent bug in shipped code. It must land before the sweep is scheduled.

**Files:**
- Modify: `src/modules/maintenance/maintenance.repository.ts`
- Test: `test/integration/sweep-grace.spec.ts`

**Interfaces:**
- Consumes: `AppConfig`, `requireEnv`, `seedBookableBooking`.
- Produces: `MaintenanceRepository.sweepExpired(now)` unchanged in signature; booking predicate gains the grace period.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/sweep-grace.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { MaintenanceRepository } from '../../src/modules/maintenance/maintenance.repository';
import { bookings } from '../../src/infra/db/schema';
import { getTestDb } from './db.helper';
import { seedBookableBooking } from './booking.fixture';

const db = getTestDb();

let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let repo: MaintenanceRepository;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule, DrizzleModule],
    providers: [MaintenanceRepository],
  }).compile();
  repo = moduleRef.get(MaintenanceRepository);
});
afterAll(async () => {
  await moduleRef?.close();
});

const NOW = new Date('2026-09-16T12:00:00.000Z');
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000);

const statusOf = async (id: string) => {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
  return row!.status;
};

describe('expiry sweep grace period', () => {
  /**
   * The bug this corrects. The sweep is about to run every 15 seconds; with the
   * old `start_at < now` predicate every booking would be expired at its own
   * start time — in the same minute the customer is told their session is
   * beginning, and before the operator can press start.
   */
  it('does not expire a booking that has only just started', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(1), status: 'confirmed' });
    await repo.sweepExpired(NOW);
    expect(await statusOf(booking.id)).toBe('confirmed');
  });

  it('does not expire a booking one minute inside the grace window', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(14), status: 'confirmed' });
    await repo.sweepExpired(NOW);
    expect(await statusOf(booking.id)).toBe('confirmed');
  });

  it('expires a booking whose whole window has elapsed', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(16), status: 'confirmed' });
    const result = await repo.sweepExpired(NOW);

    expect(await statusOf(booking.id)).toBe('expired');
    expect(result.bookingsExpired).toBe(1);
  });

  it('expires an abandoned customer_ready booking too', async () => {
    const booking = await seedBookableBooking({
      startAt: minutesBefore(16),
      status: 'customer_ready',
    });
    await repo.sweepExpired(NOW);
    expect(await statusOf(booking.id)).toBe('expired');
  });

  // A session running past its tick is late, not abandoned; only END_SESSION
  // closes it. Unchanged from phase 2, pinned here because the predicate moved.
  it('never expires an in_progress booking', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(60), status: 'in_progress' });
    await repo.sweepExpired(NOW);
    expect(await statusOf(booking.id)).toBe('in_progress');
  });

  it('records the system as the canceller', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(30), status: 'confirmed' });
    await repo.sweepExpired(NOW);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.cancelledBy).toBe('system');
    expect(row!.cancelledAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- sweep-grace`
Expected: FAIL on the first two cases — a booking one minute old is already `expired`.

- [ ] **Step 3: Apply the grace period**

Replace `src/modules/maintenance/maintenance.repository.ts` entirely:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import { bookings, operatorSlots } from '../../infra/db/schema';

@Injectable()
export class MaintenanceRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  /**
   * in_progress bookings are deliberately excluded: a session running past its
   * tick is late, not abandoned, and only END_SESSION should close it. Booked
   * past slots are likewise left alone — their booking owns that decision.
   *
   * Bookings get a grace period of one slot length before they are expired.
   * Without it, putting this on the scheduler's tick would expire every booking
   * at its own start time — in the same tick the customer is notified that
   * their session is beginning, and before the operator could press start.
   * The grace derives from SLOT_DURATION_MIN rather than a second knob, and is
   * the same bound the readiness scan uses, so the two partition the timeline.
   *
   * Open slots get no grace: unsold inventory is stale the instant its tick
   * passes.
   */
  async sweepExpired(now: Date): Promise<{ bookingsExpired: number; slotsExpired: number }> {
    const slotMinutes = requireEnv(this.config, 'SLOT_DURATION_MIN');

    return this.db.transaction(async (tx) => {
      const abandonedBefore = new Date(now.getTime() - slotMinutes * 60_000);

      const expiredBookings = await tx
        .update(bookings)
        .set({ status: 'expired', cancelledBy: 'system', cancelledAt: now, updatedAt: now })
        .where(
          and(
            lt(bookings.startAt, abandonedBefore),
            inArray(bookings.status, ['confirmed', 'customer_ready']),
          ),
        )
        .returning({ id: bookings.id });

      const expiredSlots = await tx
        .update(operatorSlots)
        .set({ status: 'expired', updatedAt: now })
        .where(and(lt(operatorSlots.startAt, now), eq(operatorSlots.status, 'open')))
        .returning({ id: operatorSlots.id });

      return { bookingsExpired: expiredBookings.length, slotsExpired: expiredSlots.length };
    });
  }
}
```

Note the unused `sql` import must be removed if eslint flags it.

- [ ] **Step 4: Write the drift guard**

The sweep transitions bookings with set-based SQL, bypassing the pure state machine. Create `src/modules/maintenance/expirable-statuses.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { transition } from '../bookings/domain/state-machine';
import type { BookingStatus } from '../bookings/domain/types';

/** Repeated verbatim from the inArray() filter in maintenance.repository.ts. */
const SWEEP_FILTER: BookingStatus[] = ['confirmed', 'customer_ready'];

const ALL_STATUSES: BookingStatus[] = [
  'confirmed',
  'customer_ready',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'expired',
];

describe('sweep filter matches the state machine', () => {
  /**
   * The sweep expires bookings in bulk rather than calling transition() per
   * row — the right choice for a batch, but it lets two definitions of
   * "expirable" drift apart silently. This fails if either side is edited alone.
   */
  it('expires exactly the statuses EXPIRE permits', () => {
    const machineAllows = ALL_STATUSES.filter(
      (status) => transition(status, 'EXPIRE', 'system', {
        now: new Date('2026-09-16T12:00:00.000Z'),
        startAt: new Date('2026-09-16T11:00:00.000Z'),
        lateCancellationMin: 60,
        bookingLeadTimeMin: 5,
      }).ok,
    );

    expect([...SWEEP_FILTER].sort()).toEqual([...machineAllows].sort());
  });
});
```

- [ ] **Step 5: Run everything and watch it pass**

Run: `pnpm test:unit -- expirable-statuses && pnpm test:integration -- sweep-grace expiry-sweep`
Expected: PASS. If the existing `test/e2e/expiry-sweep.spec.ts` now fails, it was asserting the old `start_at < now` behaviour — update its fixture times to be older than one slot length and note the change in the commit.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add src/modules/maintenance/maintenance.repository.ts src/modules/maintenance/expirable-statuses.spec.ts test/integration/sweep-grace.spec.ts test/e2e/expiry-sweep.spec.ts
git commit -m "fix: give the expiry sweep a grace period before it is scheduled

sweepExpired expired any confirmed booking whose start_at had passed. Harmless
while an admin triggered it by hand; catastrophic on a 15-second tick, where it
would expire every booking at its own start time — before the customer could
answer the session-start notification and before the operator could press start.

Bookings now need one slot length to elapse. Open slots keep no grace: unsold
inventory is stale the instant its tick passes. A unit test pins the sweep's
status filter to the state machine's EXPIRE rule, which the bulk UPDATE
bypasses."
```

---

## Task 12: The scheduling module and the tick

**Files:**
- Create: `src/modules/scheduling/scheduler.processor.ts`
- Create: `src/modules/scheduling/scheduling.module.ts`
- Test: `test/integration/tick.spec.ts`

**Interfaces:**
- Consumes: `QUEUE_CONNECTION`, `SCHEDULER_QUEUE`, `TICK_JOB`, `TICK_SCHEDULER_ID`, `ReadinessRepository`, `MaintenanceService`, `NotificationsService`.
- Produces: `SchedulerProcessor.tick(now?: Date): Promise<{ notified: number; bookingsExpired: number; slotsExpired: number }>` — public so tests drive it directly.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/tick.spec.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { QueueModule } from '../../src/infra/queue/queue.module';
import { UsersModule } from '../../src/modules/users/users.module';
import { MaintenanceModule } from '../../src/modules/maintenance/maintenance.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { NotificationsWorkerModule } from '../../src/modules/notifications/notifications.worker.module';
import { SchedulingModule } from '../../src/modules/scheduling/scheduling.module';
import { SchedulerProcessor } from '../../src/modules/scheduling/scheduler.processor';
import { PushProcessor } from '../../src/modules/notifications/push.processor';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { PUSH_PROVIDER } from '../../src/modules/notifications/push-provider';
import type { FakePushProvider } from '../../src/modules/notifications/fake-push.provider';
import { bookings } from '../../src/infra/db/schema';
import { getTestDb } from './db.helper';
import { seedBookableBooking } from './booking.fixture';

const db = getTestDb();

let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let scheduler: SchedulerProcessor;
let pushProcessor: PushProcessor;
let devices: DevicesRepository;
let push: FakePushProvider;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      DrizzleModule,
      QueueModule,
      UsersModule,
      MaintenanceModule,
      NotificationsModule,
      NotificationsWorkerModule,
      SchedulingModule,
    ],
  }).compile();
  await moduleRef.init();

  scheduler = moduleRef.get(SchedulerProcessor);
  pushProcessor = moduleRef.get(PushProcessor);
  devices = moduleRef.get(DevicesRepository);
  push = moduleRef.get<FakePushProvider>(PUSH_PROVIDER);
});
afterAll(async () => {
  await moduleRef?.close();
});

beforeEach(() => {
  push.reset();
});

const NOW = new Date('2026-09-16T12:00:00.000Z');
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe('scheduler tick', () => {
  it('notifies a booking whose start has arrived', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(1), status: 'confirmed' });
    await devices.register(booking.customerId, 'tok-tick', 'ios');

    const result = await scheduler.tick(NOW);

    expect(result.notified).toBe(1);
    // Drain the enqueued job through the real processor so the whole path runs.
    await pushProcessor.handle({
      userId: booking.customerId,
      key: 'SESSION_STARTING',
      data: { bookingId: booking.id },
    });
    expect(push.sent[0]!.token).toBe('tok-tick');
  });

  it('notifies each booking only once across repeated ticks', async () => {
    await seedBookableBooking({ startAt: minutesBefore(1), status: 'confirmed' });

    expect((await scheduler.tick(NOW)).notified).toBe(1);
    expect((await scheduler.tick(NOW)).notified).toBe(0);
  });

  it('expires an abandoned booking in the same tick', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(30), status: 'confirmed' });

    const result = await scheduler.tick(NOW);

    expect(result.bookingsExpired).toBe(1);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.status).toBe('expired');
  });

  /**
   * The two scans must not fight. A booking past its grace is expired silently
   * rather than being told its session is starting a moment before it dies.
   */
  it('never both notifies and expires the same booking', async () => {
    const booking = await seedBookableBooking({ startAt: minutesBefore(30), status: 'confirmed' });

    const result = await scheduler.tick(NOW);

    expect(result.notified).toBe(0);
    expect(result.bookingsExpired).toBe(1);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.startNotifiedAt).toBeNull();
  });

  it('is a no-op when nothing is due', async () => {
    const result = await scheduler.tick(NOW);
    expect(result).toMatchObject({ notified: 0, bookingsExpired: 0 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- tick.spec`
Expected: FAIL — `SchedulerProcessor` not found.

- [ ] **Step 3: Write the processor**

Create `src/modules/scheduling/scheduler.processor.ts`:

```ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import {
  QUEUE_CONNECTION,
  SCHEDULER_QUEUE,
  TICK_JOB,
  TICK_SCHEDULER_ID,
} from '../../infra/queue/queue.constants';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReadinessRepository } from './readiness.repository';

export interface TickResult {
  notified: number;
  bookingsExpired: number;
  slotsExpired: number;
}

@Injectable()
export class SchedulerProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerProcessor.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: IORedis,
    @Inject(ConfigService) private readonly config: AppConfig,
    private readonly readiness: ReadinessRepository,
    private readonly notifications: NotificationsService,
    private readonly maintenance: MaintenanceService,
  ) {}

  async onModuleInit(): Promise<void> {
    const prefix = requireEnv(this.config, 'QUEUE_PREFIX');
    const everyMs = requireEnv(this.config, 'SCHEDULER_TICK_SEC') * 1_000;

    this.queue = new Queue(SCHEDULER_QUEUE, { connection: this.connection, prefix });

    // upsertJobScheduler, not add({ repeat }): keyed by a stable id, it
    // replaces its own schedule when the interval changes. The older API
    // derives a repeatable job's identity from its options, so changing
    // SCHEDULER_TICK_SEC would leave the previous schedule registered
    // alongside the new one and the tick would silently run twice.
    await this.queue.upsertJobScheduler(
      TICK_SCHEDULER_ID,
      { every: everyMs },
      { name: TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );

    // Concurrency 1: the scans are cheap and set-based, and overlapping ticks
    // would buy nothing but lock contention.
    this.worker = new Worker(SCHEDULER_QUEUE, () => this.tick(), {
      connection: this.connection,
      prefix,
      concurrency: 1,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /**
   * Public so tests drive it directly — waiting on a real 15-second schedule
   * would make the suite slow and its failures hard to read.
   *
   * The two scans are independent; the order is for log readability. Notifying
   * first is nonetheless the safer order: the readiness claim is bounded to the
   * live window, so a booking past its grace is never announced and then
   * expired in the same pass.
   */
  async tick(now = new Date()): Promise<TickResult> {
    const due = await this.readiness.claimDueForStartNotification(now);
    for (const booking of due) {
      await this.notifications.notify(booking.customerId, 'SESSION_STARTING', {
        bookingId: booking.id,
      });
    }

    const swept = await this.maintenance.sweepExpired(now);

    if (due.length > 0 || swept.bookingsExpired > 0 || swept.slotsExpired > 0) {
      this.logger.log(
        `tick: notified=${due.length} bookingsExpired=${swept.bookingsExpired} slotsExpired=${swept.slotsExpired}`,
      );
    }

    return { notified: due.length, ...swept };
  }
}
```

- [ ] **Step 4: Write the module**

Create `src/modules/scheduling/scheduling.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReadinessRepository } from './readiness.repository';
import { SchedulerProcessor } from './scheduler.processor';

/**
 * Worker-only. It owns no domain rules — it decides when things run and
 * delegates what happens to MaintenanceService and ReadinessRepository. Keeping
 * it out of the bookings module is what lets the API import bookings without
 * dragging the scheduler along.
 */
@Module({
  imports: [MaintenanceModule, NotificationsModule],
  providers: [ReadinessRepository, SchedulerProcessor],
  exports: [SchedulerProcessor],
})
export class SchedulingModule {}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm test:integration -- tick.spec`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add src/modules/scheduling/ test/integration/tick.spec.ts
git commit -m "feat: scheduler tick driving readiness notification and expiry sweep

Registered with upsertJobScheduler rather than add({ repeat }): keyed by a
stable id it replaces its own schedule when SCHEDULER_TICK_SEC changes, where
the older API would leave the previous schedule registered and run the tick
twice.

tick() is public so tests drive it directly instead of waiting on a real
15-second schedule."
```

---

## Task 13: The worker entrypoint

**Files:**
- Create: `src/worker.module.ts`
- Create: `src/worker.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: every module built so far.
- Produces: `pnpm start:worker`, `pnpm start:worker:dev`.

- [ ] **Step 1: Write the worker module**

Create `src/worker.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AppLoggerModule } from './common/logging/logger.module';
import { AppConfigModule } from './infra/config/config.module';
import { DrizzleModule } from './infra/db/drizzle.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { NotificationsWorkerModule } from './modules/notifications/notifications.worker.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { UsersModule } from './modules/users/users.module';

/**
 * The consumer half of the system. It shares infra/ and the domain services
 * with AppModule, so a job handler calls exactly the code an HTTP handler
 * would — but processors are declared only here, which is what makes it
 * structurally impossible for the API process to consume jobs.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DrizzleModule,
    RedisModule,
    QueueModule,
    UsersModule,
    MaintenanceModule,
    NotificationsModule,
    NotificationsWorkerModule,
    SchedulingModule,
  ],
})
export class WorkerModule {}
```

- [ ] **Step 2: Write the entrypoint**

Create `src/worker.ts`:

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // An application context, not an HTTP app: the worker listens on no port.
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  // Without this, onApplicationShutdown never fires on SIGTERM and a redeploy
  // leaves in-flight jobs stalled until their locks expire. Harmless for a
  // push; not harmless for the transcodes arriving in sub-project #4.
  app.enableShutdownHooks();
}

void bootstrap();
```

- [ ] **Step 3: Add the scripts**

In `package.json`, add after `"start:dev"`:

```json
    "start:worker": "node dist/worker.js",
    "start:worker:dev": "node -r @swc-node/register src/worker.ts",
```

- [ ] **Step 4: Verify the worker boots, ticks, and stops cleanly**

```bash
docker compose up -d
pnpm build
node -e "require('node:fs').accessSync('dist/worker.js')" && echo "worker built"
```

Then run it for a few seconds and confirm it registers the schedule and exits on Ctrl-C without hanging:

```bash
timeout 20 node --env-file-if-exists=.env -r @swc-node/register src/worker.ts; echo "exit=$?"
```

Expected: pino output showing the app starting, no unhandled rejection, and a clean exit. A hang past the timeout means `enableShutdownHooks` or a `close()` is missing.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm build
git add src/worker.module.ts src/worker.ts package.json
git commit -m "feat: worker entrypoint

createApplicationContext rather than an HTTP app — the worker listens on no
port. enableShutdownHooks is load-bearing: without it onApplicationShutdown
never fires on SIGTERM and a redeploy leaves in-flight jobs stalled until their
locks expire."
```

---

## Task 14: Documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update Status**

Replace the Status section's first paragraph and add the plan row to the table:

```markdown
**Phases 1 (foundation + auth), 2 (locations, check-in, slot inventory, discovery, bookings)
and 3 (queue, worker, push notifications, session readiness) are implemented.** Sub-projects
#4 (media pipeline) and #5 (payments) have no spec yet.
```

| Document | Path |
|---|---|
| Phase 3 design spec | `docs/superpowers/specs/2026-09-16-acs-backend-phase3-scheduling-notifications-design.md` |
| Phase 3 plan (executed) | `docs/superpowers/plans/completed/2026-09-16-acs-backend-phase3-scheduling-notifications.md` |

- [ ] **Step 2: Update Setup and Commands**

Add to the Setup block after `pnpm start:dev`:

```
pnpm start:worker:dev         # second process: queue consumers + the scheduler tick
```

Add to the Commands table:

| `pnpm start:worker:dev` | The worker process — nothing scheduled runs without it |

- [ ] **Step 3: Update Layout**

Add to the `src/` tree:

```
  worker.ts                Worker bootstrap (no HTTP listener)
  worker.module.ts         Consumer-side module graph
  infra/
    queue/                 BullMQ connection + push queue producer
  modules/
    notifications/         PushProvider port + Expo/fake adapters, templates, devices, processor
    scheduling/            the repeatable tick, readiness claim scan
```

- [ ] **Step 4: Add the new conventions**

Append to "Conventions that are enforced":

```markdown
- **Postgres owns the schedule; BullMQ owns dispatch.** Time-driven work ("what is due now")
  is a set-based scan on the scheduler tick. Event-driven work ("send this push", and #4's
  "process this video") is a queued job. Do not reach for a delayed job to remember that
  something is owed later: Redis here has no persistence configured, so a restart would drop
  it with nothing in the database aware.
- **Processors are declared only in `WorkerModule`'s graph**, never in a module `AppModule`
  imports. That is what makes it structurally impossible for the API process to consume jobs;
  a runtime flag would eventually be set wrong in one environment.
- **Push vendors:** no vendor name may appear outside `src/modules/notifications/`, the same
  rule as `src/modules/sms/`. The `PushProvider` port is one method.
- **A push is the one place the server resolves a locale.** The OS renders the text, so the
  client cannot localize it afterwards. `users.preferred_locale` plus `push-templates.ts`,
  exactly as `otp-templates.ts` does for SMS. Everything else still returns whole
  `LocalizedText` objects.
```

- [ ] **Step 5: Add the traps**

Append to "Traps":

```markdown
**BullMQ needs its own ioredis connection.** It requires `maxRetriesPerRequest: null`, and the
shared `REDIS` provider sets `2` — which aborts the long blocking reads its workers depend on.
`infra/queue/queue.module.ts` constructs a separate client and closes it itself. Don't
"deduplicate" the two.

**`onConflictDoUpdate` spells the partial-index predicate `targetWhere`.** `onConflictDoNothing`
spells the same thing `where` (already noted above), which is exactly why this one gets written
backwards. Wrong, and the partial index is not inferred — the upsert fails at runtime.

**Register repeatable jobs with `upsertJobScheduler`, not `queue.add({ repeat })`.** The older
API derives a repeatable job's identity from its options, so changing `SCHEDULER_TICK_SEC`
leaves the previous schedule registered alongside the new one and the tick silently runs twice.

**The worker needs `app.enableShutdownHooks()`.** `createApplicationContext` does not install
signal handlers, so without it `onApplicationShutdown` never fires on SIGTERM and a redeploy
leaves in-flight jobs stalled until their locks expire.

**The expiry sweep's grace period is load-bearing.** `sweepExpired` expires bookings older than
`start_at + SLOT_DURATION_MIN`, not `start_at`. It runs on a 15-second tick: simplify the
predicate back and every booking is expired at its own start time, before the customer can
answer the session-start notification and before the operator can press start.
`test/integration/sweep-grace.spec.ts` pins it.
```

- [ ] **Step 6: Update Testing**

Add to the list of behaviours whose tests must keep passing:

```markdown
- **two concurrent readiness ticks must notify exactly once**
  (`test/integration/readiness-scan.spec.ts`). Duplicate pushes are a bug users report rather
  than monitoring;
- **the sweep must not expire a booking inside its grace window**
  (`test/integration/sweep-grace.spec.ts`);
- **registering a live device token under a second user must revoke the first binding**
  (`test/integration/device-tokens.spec.ts`) — one handset changing hands would otherwise
  deliver the previous user's booking notifications to the new one.
```

Update the state machine line: the grid is now **7 statuses x 6 events x 4 actors = 168 cells, 15 allowed and 153 rejected**.

- [ ] **Step 7: Update Known gaps**

Remove the three gaps this phase closed and add the new ones:

- Delete "No job queue, media pipeline, or payments yet — sub-projects #3–#5, unplanned." → replace with "No media pipeline or payments yet — sub-projects #4–#5, unplanned."
- Delete "The expiry sweep is admin-triggered only" — it now also runs on the tick (the admin route remains).
- Replace "No readiness reminders yet" with:

```markdown
- **`START` is still permitted straight from `confirmed`.** The reason changed: readiness
  notifications exist now, but if the worker is down no notification is sent, and a customer
  who was never asked must not be blocked from their session. The feature degrades to phase 2
  behaviour under outage. Don't "tighten" this.
- **Push delivery receipts are not read.** An accepted send counts as delivered; Expo reports
  real outcomes only via its receipts endpoint, polled minutes later.
- **No operator nudge** when an acknowledgement never arrives. The operator is at the location
  with the app open and the booking screen shows the state.
- **No notification preferences or quiet hours.** Everything sent is transactional and follows
  directly from the user's own booking, so there is nothing yet to opt out of.
```

- [ ] **Step 8: Move the plan to completed and commit**

```bash
mkdir -p docs/superpowers/plans/completed
git mv docs/superpowers/plans/2026-09-16-acs-backend-phase3-scheduling-notifications.md docs/superpowers/plans/completed/
git add AGENTS.md
git commit -m "docs: record phase 3 as implemented and fold its traps into AGENTS.md

Deviations from the plan, with reasons:
- PUSH_SEND_FAILED was not added to ErrorCodes. That file is the client
  contract and the code never reaches a client; it is a plain PushSendError.
- notify()'s third argument is the push data payload, not template parameters.
  Neither template interpolates anything, so parameter plumbing would have had
  no consumer, while the client does need a bookingId to open the right screen.
- The tick uses upsertJobScheduler rather than manual repeatable-job cleanup on
  boot, which removes the stale-schedule trap instead of documenting it."
```

---

## Self-review notes

Checked against the spec:

- §1.2 corrections → Tasks 10 (operator ack), 12 (notification at start, no auto-cancel). No `no_ack` status anywhere. ✓
- §2.1 two processes → Tasks 5, 6, 13. ✓
- §2.2 Postgres owns schedule → Task 9, documented in Task 14. ✓
- §2.3 raw `bullmq` → Task 1 Step 1. ✓
- §2.4 layout → matches File Structure. ✓
- §3.1 `device_tokens` incl. owner reassignment → Task 2. ✓
- §3.2 `start_notified_at` + partial index → Task 8. ✓
- §3.3 migration hand-check → Tasks 2 Step 5, 8 Step 2. ✓
- §4.2 state machine → Task 10. ✓
- §4.3 both scans incl. the lower bound → Tasks 9, 12. ✓
- §4.4 sweep grace → Task 11. ✓
- §5.1 port and adapters → Task 3. ✓
- §5.2 templates → Task 4. ✓
- §5.3 send path and reaping → Task 6. ✓
- §6 endpoints and matrix (26 rows) → Tasks 7, 10. ✓
- §7 config → Task 1. ✓
- §8 error model → Task 7, with the recorded deviation on `PUSH_SEND_FAILED`. ✓
- §9 all five pinned behaviours → Tasks 9 (concurrency), 11 (grace, drift guard), 2 (token reassignment), 6 (reaping). ✓
- §10 traps → Task 14. ✓
- §11 known gaps → Task 14. ✓
