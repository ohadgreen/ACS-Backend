# ACS Backend — Scheduling, Push Notifications & Session Readiness

**Status:** approved design
**Date:** 2026-09-16
**Sub-project:** #3 of the five listed in `2026-09-02-acs-backend-foundation-booking-design.md` §1
**Source:** `photographer-app-design.md` §3.5, plus corrections recorded in §1.2 below

---

## 1. Scope

Sub-project #3: the job queue, the background worker process, push notification
delivery, and the session-readiness handshake. It also moves the expiry sweep —
implemented and tested in #2 but reachable only by an admin request — onto a
schedule.

This phase exists mostly to unblock #4. The media pipeline needs a worker
process for ffmpeg, a queue to carry upload-processing jobs, and a push channel
to tell a customer their preview is ready. All three are built here, with the
readiness handshake as the first real consumer.

| In scope | |
|---|---|
| Queue | BullMQ over Redis, producer side in the API, consumer side in a new worker process |
| Worker | `src/worker.ts` — second entrypoint, same modules, no HTTP listener |
| Push | `PushProvider` port, Expo adapter, fake adapter, locale-keyed templates |
| Devices | `device_tokens` table, registration and revocation endpoints |
| Readiness | Session-start notification, operator-side acknowledgement |
| Scheduling | Repeatable tick driving the start notification and the expiry sweep |

### 1.1 Explicitly out of scope

- **Media upload, ffmpeg processing, storage and delivery (#4).** This phase
  builds the queue and the push channel that #4 consumes; it adds no media
  tables, no object storage, and no `PROMO_READY` template.
- **Identity photo (product design §3.4).** Deferred by the customer; not
  scheduled to any phase.
- **Payments (#5).**
- **Push delivery receipts.** Expo's second-phase receipt API confirms delivery
  minutes after the send is accepted. The MVP treats an accepted send as
  delivered and only reacts to synchronous errors (§5.3). Recorded as a known
  gap.
- **Realtime sockets.** The foundation spec §1.1 accepts polling; a push at
  session start does not change that.
- **Operator nudge notifications.** No "the customer still hasn't confirmed"
  reminder. The operator is physically present at `start_at` with the app open,
  and the booking screen carries the acknowledgement state. Revisit only if
  operators report missing it.

### 1.2 Corrections to the product design

Product design §3.5 specifies a reminder five minutes *before* the session, a
`customer_ready` transition, and an auto-cancel or at-risk flag if no
acknowledgement arrives by a grace deadline. Three corrections, all decided with
the product owner on 2026-09-16:

1. **The pre-session reminder is dropped.** The notification fires *at*
   `start_at` — "your session starts now" — not five minutes before it. A
   customer standing at a filming location does not benefit from a countdown;
   they benefit from knowing the operator is ready for them.

2. **There is no automatic cancellation.** The design's grace-deadline
   auto-cancel was considered and rejected: it destroys a real booking whenever
   a present customer has a pocketed phone, and the operator — the one party
   with direct evidence of whether the customer showed up — would have been
   powerless to stop it. Resolution is instead explicitly human.

3. **The operator may acknowledge on the customer's behalf.** If the customer
   does not respond, the operator either acknowledges (visual confirmation that
   the customer is present) or marks a no-show. Both paths already exist in the
   state machine; only the actor list changes (§4.2).

The consequence is that no new booking status is introduced. An earlier draft of
this design added `no_ack` to distinguish "never confirmed readiness" from
"slot time passed"; with auto-cancel gone there is nothing to distinguish, and
`expired` continues to mean exactly what it meant in #2.

---

## 2. Architecture

### 2.1 Two processes

The foundation spec §2.1 committed to this shape. It arrives now.

```
src/main.ts     → AppModule      → HTTP listener, queue producers
src/worker.ts   → WorkerModule   → queue consumers, scheduler, no HTTP
```

`src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)`.
Both graphs import the same `infra/` and the same domain services, so a job
handler calls exactly the code an HTTP handler would.

**The split lives in the module graph, not a runtime flag.** `AppModule` imports
the queue's producer side only; processor providers are declared exclusively in
`WorkerModule`. There is therefore no configuration under which the API process
starts consuming jobs — a flag would eventually be set wrong in one environment,
and a half-consuming API is an unpleasant thing to diagnose.

This matters more in #4 than it does here. Phase 3's jobs are network calls that
finish in milliseconds; ffmpeg is CPU-bound and would starve the API's event
loop for the length of every transcode. Building the split now means #4 adds a
processor rather than restructuring the deployment at the same time as writing
the media pipeline.

### 2.2 Postgres owns the schedule, Redis owns dispatch

The governing principle for this phase, and the one most likely to be
inadvertently reversed later:

> **BullMQ carries event-driven work — "send this push", "process this video".
> Postgres carries time-driven work — "what is due right now".**

Product design §3.5 specifies a BullMQ delayed job per booking, scheduled at the
reminder time. That was rejected. A delayed job makes Redis the system of record
for "a notification is owed": this deployment runs a stock `redis:7` with no
persistence configured, used so far only as a cache and rate limiter, so a Redis
restart would silently drop every pending notification with nothing in the
database aware that it happened. Cancelled bookings would also leave orphaned
jobs that each handler must defensively re-check against the database — which is
the scan, reimplemented, with an extra moving part in front of it.

Instead, one repeatable job ticks every `SCHEDULER_TICK_SEC` and runs set-based
statements against Postgres to find what is due. Redis holds only the tick. The
properties that buys:

- **Durability is free.** A worker outage loses nothing; the next tick finds
  everything still due and catches up.
- **Idempotency is a column, not a convention.** `start_notified_at` is claimed
  by the same `UPDATE` that reads it, so correctness does not depend on job-id
  discipline.
- **It is the shape already in the repository.** `MaintenanceRepository.sweepExpired`
  is exactly this: a transaction of set-based statements taking an injected
  `now`. Phase 3 adds a second scan beside it rather than a second paradigm.

The cost is timing jitter bounded by one tick. At 15 seconds, against a
15-minute session, this is not perceptible.

A hybrid — delayed jobs for precision with a scan as reconciliation backstop —
is strictly more accurate and was rejected on YAGNI grounds: two mechanisms
doing one job, where the cheaper one is already accurate enough.

### 2.3 Stack additions

| Concern | Choice | Rationale |
|---|---|---|
| Queue | `bullmq`, used directly with hand-written Nest providers | The surface is two queues and two processors. `@nestjs/bullmq` would wrap roughly forty lines of provider code, and every added `@nestjs/*` dependency is a v11/v12 resolution gamble this repository has already lost once (AGENTS.md, "Version pins are load-bearing") |
| Push transport | Expo Push behind a `PushProvider` port | The clients are Expo managed-workflow React Native. Expo's service relays to FCM and APNs, so the MVP needs no Firebase service account and no APNs certificate. The port means switching to FCM directly is one adapter plus a case in the module factory — the `SmsProvider` arrangement, unchanged |

### 2.4 Code organization

```
src/
  worker.ts                        second entrypoint
  infra/
    queue/
      queue.module.ts              BullMQ connection + Queue providers (producer side)
      queue.constants.ts           queue names, job names
  modules/
    notifications/
      push-provider.ts             port: send(messages) => per-message results
      expo-push.provider.ts        adapter
      fake-push.provider.ts        adapter (+ spec)
      push-templates.ts            locale-keyed titles and bodies (+ spec)
      notifications.service.ts     enqueue a notification for a user
      push.processor.ts            worker side: resolve, render, send, reap
      devices.controller.ts        register / unregister a device token
      devices.repository.ts
      notifications.module.ts
    scheduling/
      scheduling.module.ts         registers the repeatable tick (worker only)
      tick.processor.ts            runs the scans in order
      readiness.repository.ts      the start-notification claim scan
      readiness.service.ts
```

`notifications/` mirrors `sms/` deliberately: a one-method port, a real adapter,
a fake adapter, a locale-keyed template module with its own spec, and the rule
that **no vendor name appears outside the directory**.

`scheduling/` is a separate module rather than an extension of `bookings/`
because it owns no domain rules — it decides *when* things run, and delegates
*what* happens to `MaintenanceService` and `ReadinessService`. Putting the tick
inside `bookings/` would make the booking module depend on the queue, which
would make it impossible to import from the API process without dragging the
scheduler along.

---

## 3. Data model

### 3.1 `device_tokens`

A push notification needs an address. The server knows `users.id`; Expo, APNs
and FCM know only a token issued by the operating system to one installation of
the app on one device, obtainable solely by the client. This table is the
mapping between them.

```sql
CREATE TYPE device_platform AS ENUM ('ios', 'android');

device_tokens (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  token         text NOT NULL,
  platform      device_platform NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE UNIQUE INDEX device_tokens_active_token
  ON device_tokens (token) WHERE revoked_at IS NULL;
CREATE INDEX device_tokens_user_idx
  ON device_tokens (user_id) WHERE revoked_at IS NULL;
```

A table rather than a `users.push_token` column, because the relationship is
genuinely not one-to-one:

- **One user, several devices.** A phone and a tablet should both receive.
- **Tokens rotate.** Reinstalling the app or an OS-initiated refresh invalidates
  the old value, and the new one must be addable without assuming the old one
  has already been reported dead.
- **Devices change hands.** See below — the reason the unique index is partial
  and active-scoped.
- **Tokens die silently.** An uninstall is only discovered when a send returns
  `DeviceNotRegistered`, and that fact needs somewhere to be written.

**Registration reassigns a token away from its previous owner.** Customer A logs
out, customer B logs in on the same handset, and B's registration presents the
token that was bound to A. Left alone, A would continue receiving push
notifications — containing booking times and locations — on B's phone. That is a
privacy incident, not an untidiness. Registration therefore runs in one
transaction:

```sql
UPDATE device_tokens SET revoked_at = now()
  WHERE token = $1 AND revoked_at IS NULL AND user_id <> $2;

INSERT INTO device_tokens (...) VALUES (...)
  ON CONFLICT (token) WHERE revoked_at IS NULL
  DO UPDATE SET last_seen_at = now(), platform = EXCLUDED.platform;
```

Revoking rather than deleting preserves the history of which user held which
device, which is the only evidence available if a misdelivery is ever reported.

### 3.2 `bookings` additions

```sql
ALTER TABLE bookings ADD COLUMN start_notified_at timestamptz;

CREATE INDEX bookings_start_notify_idx ON bookings (start_at)
  WHERE status = 'confirmed' AND start_notified_at IS NULL;
```

`start_notified_at` is both the idempotency record and the claim token for the
scan (§4.3). The index is partial, so a row leaves it as soon as it is notified:
the scan reads a handful of rows regardless of how large `bookings` grows, and
the index itself stays approximately the size of the pending set rather than the
table.

No enum changes. No new statuses.

### 3.3 Migration notes

Two migrations, generated with `pnpm migrate:generate` and applied with
`pnpm migrate`.

Both partial indexes must be hand-checked after generation: drizzle-kit renders
an index predicate written as `` sql`${t.status} = 'confirmed'` `` with a
table-qualified column reference, which `CREATE INDEX ... WHERE` rejects. The
predicate must be written with bare column names (AGENTS.md, "An index predicate
takes a bare column name"), and the same text repeated verbatim in the
`onConflictDoUpdate` target so Postgres can infer the partial index.

---

## 4. Session readiness

### 4.1 The flow

```
start_at reached
  │
  ├─ tick claims the booking, pushes "your session starts now" to the customer
  │
  ├─ customer acknowledges          → customer_ready, operator notified
  ├─ operator acknowledges for them → customer_ready, no notification
  ├─ operator marks no-show         → no_show
  └─ nobody acts for a slot length  → expired by the sweep
```

`START` remains permitted from `confirmed` as well as `customer_ready`. #2
allowed this because readiness reminders did not exist yet; it stays for a
different reason now — **if the worker is down, no notification is sent, and a
customer who was never asked must not be prevented from having their session.**
The feature degrades to #2's behaviour under outage instead of blocking real
sessions. AGENTS.md's instruction not to tighten that rule therefore stands, with
the rationale updated.

### 4.2 State machine change

One edit to the rules table in `bookings/domain/state-machine.ts`:

```
CUSTOMER_ACK.actors: ['customer']  →  ['customer', 'operator']
```

The grid stays 7 statuses × 6 events × 4 actors = 168 cells. Allowed cells go
from 14 to 15; rejected from 154 to 153. The coverage assertion in
`state-machine.spec.ts` forces the counts to be updated deliberately.

`BookingsController.ack` widens from `@Roles('customer')` to
`@Roles('customer', 'operator')` and passes `user.role` as the actor rather than
the literal `'customer'`. Ownership is unaffected: `BookingsService.act` already
requires an operator caller to match `booking.operator_id`, so an operator can
only acknowledge a booking assigned to them.

The event keeps the name `CUSTOMER_ACK`. It records that the customer is
present; the operator is a witness to that fact, not a second kind of event.

### 4.3 The tick

One repeatable BullMQ job, `scheduler:tick`, every `SCHEDULER_TICK_SEC`
(default 15), registered on worker boot. It runs two independent scans in order.
Neither depends on the other; the ordering is for log readability.

**Scan 1 — session-start notification.**

```sql
UPDATE bookings
   SET start_notified_at = now()
 WHERE status = 'confirmed'
   AND start_notified_at IS NULL
   AND start_at <= now()
   AND start_at >  now() - (SLOT_DURATION_MIN || ' minutes')::interval
RETURNING id, customer_id;
```

The claim and the record are the same statement, so two worker replicas cannot
both send the same notification — the second `UPDATE` matches no rows. Each
returned row enqueues one `SESSION_STARTING` notification.

Only `confirmed` bookings are scanned: a booking already `customer_ready` needs
no prompt, and every other status is terminal or in progress.

**The lower bound on `start_at` is not redundant.** After a worker outage the
scan would otherwise find bookings whose window closed hours ago and push "your
session starts now" for a session that scan 2 expires seconds later, in the same
tick. Bounding the claim to the still-live window means a booking past its grace
is simply expired, unannounced. The bound is the same `SLOT_DURATION_MIN` the
sweep uses, so the two scans partition the timeline with no gap and no overlap.

**Scan 2 — abandonment sweep.** `MaintenanceService.sweepExpired`, unchanged in
structure, corrected in predicate (§4.4).

### 4.4 Correction to the expiry sweep

`MaintenanceRepository.sweepExpired` currently expires any `confirmed` or
`customer_ready` booking whose `start_at < now`. That is harmless while an
administrator triggers it by hand and **catastrophic the moment it is put on a
15-second timer**: every booking would be expired at its own start time, in the
same minute the customer is notified that their session is beginning and before
the operator can press start.

The predicate becomes:

```
start_at < now - (SLOT_DURATION_MIN minutes)
```

The booked window has fully elapsed with no party acting, so there is nothing
left to run. The grace derives from `SLOT_DURATION_MIN` rather than introducing
a second knob whose relationship to the slot length would have to be remembered.

The slot half of the sweep — open `operator_slots` whose `start_at` has passed —
is unchanged. Unsold inventory is stale the instant its tick passes, and no
grace applies.

This correction is required for the sweep to be schedulable at all, and is
pinned by a test (§9).

---

## 5. Notifications

### 5.1 Port and adapters

```ts
interface PushMessage { token: string; title: string; body: string; data?: Record<string, string> }
interface PushResult  { token: string; ok: boolean; error?: 'DEVICE_NOT_REGISTERED' | 'TRANSIENT' | 'INVALID' }

interface PushProvider { send(messages: PushMessage[]): Promise<PushResult[]> }
```

`ExpoPushProvider` posts to Expo's send endpoint in batches of 100 and maps
Expo's per-ticket error codes onto the three `PushResult` errors. The port
returns per-message results rather than throwing, because a batch routinely
succeeds partially and a thrown error would lose which tokens survived.

`FakePushProvider` records messages in memory and is selected by
`PUSH_PROVIDER=fake`. Integration and e2e tests read sent messages back out of
it, so the whole path — enqueue, resolve, render, send — executes rather than
being mocked away. This mirrors how `FakeSmsProvider` carries the OTP tests.

### 5.2 Templates and localization

The backend's standing rule is that it never pre-resolves a locale for display
strings (`LocalizedText` responses carry every locale). A push notification is
the documented exception — it is text the backend originates, which the client
cannot localize after delivery. The foundation spec §2.4 anticipated this
explicitly, and `auth/otp/otp-templates.ts` is the established pattern.

`push-templates.ts` is a locale-keyed table of `{ title, body }` with parameter
substitution, falling back to English for an unrecognized locale. Its spec
asserts that every supported locale renders every key and that no `{placeholder}`
survives substitution — the same two assertions that guard the OTP templates.

Two keys in this phase:

| Key | Recipient | Trigger |
|---|---|---|
| `SESSION_STARTING` | customer | scan 1 claims the booking |
| `CUSTOMER_READY` | operator | a `CUSTOMER_ACK` by the **customer** |

`CUSTOMER_READY` is not sent when the operator acknowledges on the customer's
behalf — the operator would be notifying themselves of something they just did.

#4 adds `PROMO_READY`.

### 5.3 Send path and token lifecycle

`NotificationsService.notify(userId, key, params)` enqueues a single job carrying
those three values and nothing else.

**Device tokens and locale are resolved inside the processor, at send time, not
at enqueue time.** A job that retries after a backoff must not push to a token
revoked in the interim, and a small payload keeps the queue cheap to inspect.

The processor then:

1. loads the user's `preferred_locale` and active device tokens;
2. renders the template;
3. calls `PushProvider.send`;
4. **revokes every token that came back `DEVICE_NOT_REGISTERED`** — the app was
   uninstalled. Without this, dead tokens accumulate permanently and every
   subsequent send does provably wasted work;
5. throws if any result was `TRANSIENT`, so BullMQ retries with exponential
   backoff. `INVALID` does not throw: a malformed token is not fixed by retrying.

A user with no active tokens is not an error. They have not installed the app or
have not granted permission, and the job completes having sent nothing.

---

## 6. Endpoint surface

| Method | Path | Roles | Notes |
|---|---|---|---|
| `POST` | `/me/devices` | customer, operator, admin | Register a push token. `200`, not `201`: repeat registration of a live token updates `last_seen_at` rather than creating |
| `POST` | `/me/devices/revoke` | customer, operator, admin | Revoke on logout. `200` |
| `POST` | `/bookings/:id/ack` | **customer, operator** | Was customer-only |

`POST /me/devices` is idempotent by design. The client cannot reliably know
whether it has registered its current token — the OS may rotate it between
launches — so it registers on every foreground and the server absorbs the
repetition.

Revocation is a `POST` carrying the token in the body rather than
`DELETE /me/devices/:token`, because an Expo token is shaped
`ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]` and the brackets would have to
survive percent-encoding through every client, proxy and log along the way. It
also matches how every other action in this API is already expressed
(`/bookings/:id/cancel`, `/presence/check-out`).

The authorization matrix in `test/e2e/authz-matrix.spec.ts` goes from 24 rows to
26, and the existing `ack` row changes: an operator who is a party to the booking
must now receive 200 where it previously asserted 403. Both edits are deliberate
changes to the row-count assertion.

---

## 7. Configuration

New entries in `infra/config/env.schema.ts`:

| Variable | Default | Notes |
|---|---|---|
| `PUSH_PROVIDER` | `expo` | `expo` \| `fake` |
| `EXPO_ACCESS_TOKEN` | — | Optional. Expo requires it only when a project enables enhanced push security, so unlike the SMS credentials it is **not** conditionally required by the schema refinement |
| `QUEUE_PREFIX` | `acs` | Namespaces BullMQ keys so environments sharing a Redis cannot collide |
| `SCHEDULER_TICK_SEC` | `15` | Bounds notification lateness |
| `WORKER_CONCURRENCY` | `5` | Per-queue consumer concurrency |

`SLOT_DURATION_MIN` gains a second consumer — the sweep grace (§4.4). It remains
a single value; the sweep derives from it rather than duplicating it.

`PUSH_PROVIDER=fake` belongs in `vitest.integration.config.ts` and
`vitest.unit.config.ts`, **not** in a test helper. `ConfigModule.forRoot()`
validates the environment during import hoisting, before any `beforeAll` could
set a variable (AGENTS.md, "Test environment lives in `vitest.integration.config.ts`").

---

## 8. Error model

Two codes added to `common/errors/error-codes.ts`:

| Code | Status | Raised when |
|---|---|---|
| `DEVICE_NOT_FOUND` | 404 | `/me/devices/revoke` names a token the caller does not hold |
| `PUSH_SEND_FAILED` | — | Internal, thrown inside the processor to trigger retry; never reaches a client |

Token shape is validated by the zod DTO and reported as the existing
`VALIDATION_FAILED`; a dedicated code would duplicate the pipe for no gain.

`DEVICE_NOT_FOUND` is deliberately a 404 rather than a silent success: the client
using it on logout wants to know whether the revocation actually happened, and a
token it does not hold is a sign of a client-side bookkeeping bug worth
surfacing. It leaks nothing — the caller already presented the token.

---

## 9. Testing strategy

Standard coverage aside, five behaviours get tests because getting them wrong is
subtle and the failure is silent:

1. **Two concurrent ticks over the same due booking send exactly one
   notification.** The analogue of `booking-concurrency.spec.ts`. If the claiming
   `UPDATE` is ever split into a `SELECT` followed by an `UPDATE`, this is what
   catches it — and duplicate pushes are the kind of bug that is reported by
   users rather than by monitoring.

2. **The sweep does not expire a booking inside the grace window, and does
   expire one outside it.** §4.4 is a correction to working-looking code; without
   a test pinning it, a future reader simplifying the predicate back to
   `start_at < now` would break every session in production and pass CI.

3. **Registering a live token under a second user revokes the first binding.**
   The privacy case in §3.1.

4. **A `DEVICE_NOT_REGISTERED` result revokes that token** rather than being
   swallowed, and the revoked token is absent from the next send.

5. **A drift guard asserting the sweep's status filter still equals the state
   machine's `EXPIRE.from` set.** The sweep transitions bookings with set-based
   SQL, bypassing the pure machine — a deliberate choice for a batch operation,
   but one that lets the two definitions of "expirable" diverge silently. The
   test fails if either side is edited alone.

Unit-level: `push-templates.spec.ts` mirrors `otp-templates.spec.ts` — every
locale renders every key, no placeholder survives, English is the fallback.
`state-machine.spec.ts` grid counts move to 15 allowed / 153 rejected.

E2E: an operator acknowledging a booking assigned to them succeeds; an operator
acknowledging someone else's booking gets 403 from the existing ownership check.

Queue tests run against the real Redis already in `docker-compose.yml`. The tick
is invoked directly in tests rather than waited for — the repeatable schedule is
BullMQ's responsibility, and a suite that sleeps for 15 seconds per case is one
nobody runs.

---

## 10. Traps

Recorded here and to be carried into AGENTS.md on completion.

**BullMQ needs its own ioredis connection.** It requires
`maxRetriesPerRequest: null`; the shared `REDIS` provider in
`infra/redis/redis.module.ts` sets `2`, and BullMQ throws on a client configured
that way. The two connections cannot be shared, and the queue module must
construct its own — including its own `onApplicationShutdown`.

**`onConflictDoUpdate` spells the partial-index predicate `targetWhere`.**
AGENTS.md already records that `onConflictDoNothing` takes `where`. The
doUpdate form is the inverse, which is exactly why it gets written backwards.
Used wrongly, the partial index is not inferred and the upsert fails at runtime
rather than at type-check.

**The worker needs explicit graceful shutdown.** Without closing BullMQ workers
on `SIGTERM`, a redeploy leaves in-flight jobs stalled until the lock expires.
Harmless for a push; not harmless for a #4 transcode.

**A repeatable job's identity is derived from its options.** Changing
`SCHEDULER_TICK_SEC` leaves the old repeatable schedule registered alongside the
new one. The scheduler must remove existing repeatable jobs for its key on boot
before adding the current one, or the tick silently doubles after a config
change.

---

## 11. Known gaps on completion

- **Push delivery receipts are not read.** An accepted send is treated as
  delivered. Expo surfaces real delivery outcomes only via its receipts endpoint,
  polled minutes later; wiring it is a follow-up whose natural home is whenever
  push reliability first becomes a question worth asking.
- **No operator nudge** when an acknowledgement does not arrive (§1.1).
- **No per-user notification preferences or quiet hours.** Every notification in
  this phase is transactional and directly requested by the user's own booking,
  so there is nothing yet to opt out of. #5's payment receipts may change that.
- **`start_notified_at` is never reset.** A booking cannot return to `confirmed`
  from `customer_ready`, so it cannot need a second notification. If a future
  phase adds such a transition, this column has to be cleared with it.
