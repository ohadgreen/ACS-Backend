# ACS Backend — Media Pipeline, Delivery & Dummy Purchase

**Status:** approved design
**Date:** 2026-09-16
**Sub-project:** #4 of the five listed in `2026-09-02-acs-backend-foundation-booking-design.md` §1
**Source:** `photographer-app-design.md` §3.6 and §3.8, plus corrections recorded in §1.3 below

---

## 1. Scope

The media pipeline: an operator uploads a drone video, a worker cuts a short
promo clip from it, the customer is notified and can watch the promo, and a
purchase unlocks the full-resolution original.

| In scope | |
|---|---|
| Storage | `ObjectStorage` port, one S3-compatible adapter, one fake |
| Upload | Presigned direct upload, intent/confirm handshake, content-hash dedupe |
| Processing | ffmpeg trim to a 5-second 720p promo, in the Phase 3 worker |
| Delivery | Promo and full-resolution access by short-TTL signed URL |
| Purchase | A dummy, zero-gateway purchase that unlocks full-res and notifies the operator |
| Scheduling | A third scan on the Phase 3 tick, failing abandoned upload intents |

### 1.1 Dependency on Phase 3

**This phase cannot be executed before Phase 3 is.** It consumes, by name:

- `src/worker.ts` and `WorkerModule` — the process ffmpeg runs in
- `src/infra/queue/` — the BullMQ connection and the producer pattern
- `NotificationsService.notify(userId, key, data)` and `push-templates.ts`
- `SchedulerProcessor.tick()` — gains a third scan here

Specifying and planning ahead of execution is fine; the interfaces above are
already committed in Phase 3's spec and plan.

### 1.2 Explicitly out of scope

- **Payments (#5).** The purchase built here moves no money and calls no
  gateway. §7 of the product design establishes that Stripe does not support
  Israeli entities; gateway selection remains #5's decision.
- **Identity photo (product design §3.4).** Dropped by the product owner; not
  scheduled to any phase.
- **Watermarking.** See §1.3.
- **Multipart and resumable upload.** A single presigned `PUT` with a size cap.
  The operator uploads over venue wifi immediately after a session, and the
  operating procedure in §3.8 already requires transferring after every shoot.
  Recorded as the known upgrade path.
- **The §3.6 auto-editing enhancement** — motion-based trimming, branded outro.
  The design defers it until there is real footage to tune against.
- **Media retention and deletion.** Originals accumulate. See §12.
- **Client-side DCIM scanning and candidate disambiguation (§3.8).** That is
  React Native work; this spec covers only the backend it talks to.

### 1.3 Corrections to the product design

Decided with the product owner on 2026-09-16.

1. **No watermark.** Product design §3.6 step 2 overlays a watermark on the
   promo. Dropped: the promo is a clean 5-second trim. The consequence is that
   the preview is usable footage, which is accepted as a sales hook rather than
   a leak.

2. **The promo is re-encoded to 720p, not stream-copied.** A 5-second clip at
   source resolution is 10–20MB, and far more from 4K; at 720p it is roughly
   2MB. The customer streams it in-app, possibly on cellular, and egress is
   paid on every view including repeats. Two or three seconds of CPU per job is
   trivial beside the download and upload surrounding it.

3. **A booking holds many media files, not one.** Product design §3.8 specifies
   a unique constraint on `media_assets.booking_id`. A session routinely
   produces several clips, so that constraint is wrong and is dropped.

   **This does not weaken §3.8's guarantee that a video can never be silently
   attached to two bookings** — that rests on the *content-hash* uniqueness,
   not the per-booking one. One file yields at most one live asset, therefore at
   most one booking. The per-booking index was enforcing a different and
   incorrect claim.

4. **No transfer via the DJI Fly app.** Product design §3.8 assumes DJI Fly
   writes to `DCIM/DJI Album`. In reality the drone is connected directly to the
   operator's device, or its SD card is inserted into it, and the footage is
   read from `DCIM`. This changes only the client; the backend contract is
   unaffected, and no drone SDK is involved either way.

5. **Full-resolution delivery is gated by a purchase that costs nothing.**
   Product design §3.7 gates it behind a real payment. Here the purchase writes
   a row, notifies the operator, and unlocks access, with no gateway involved.
   Building the gate now and pricing it at zero means the shape is exercised end
   to end; #5 inserts a gateway call rather than retrofitting an access check
   onto a route that shipped open. See §6.

---

## 2. Architecture

### 2.1 Bytes never pass through Node

Both directions are presigned URLs straight between the client and object
storage. The API issues credentials and records intent; it never proxies a
200MB video, which would occupy a request worker for the length of an upload
and put the whole file through the event loop.

```
operator app ──── PUT (presigned) ────────────────► object storage
     │                                                    ▲  │
     └── POST /upload-intent, /confirm ──► API            │  │ GET
                                            │             │  │
                                            ▼             │  ▼
                                      BullMQ ──► worker ──┘  ffmpeg
                                                     │
customer app ◄── signed URL ◄── API ◄────────────────┘
```

### 2.2 Storage port and adapters

```ts
interface UploadTicket {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

interface ObjectStorage {
  createUploadUrl(key: string, opts: { contentType: string; maxBytes: number; ttlSec: number }): Promise<UploadTicket>;
  createDownloadUrl(key: string, opts: { ttlSec: number; filename?: string }): Promise<string>;
  head(key: string): Promise<{ bytes: number; contentType: string } | null>;
  getStream(key: string): Promise<Readable>;
  put(key: string, body: Readable | Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

One adapter, `S3CompatibleStorage`, serves Hetzner Object Storage, Cloudflare
R2, MinIO and AWS S3. These differ by endpoint, region and path-style
addressing — configuration — not by protocol. **Switching storage vendors is
therefore an environment change, not a code change**, which is the property
requested. A second adapter is only needed for a vendor that is not
S3-compatible, and none is in view.

`FakeObjectStorage` keeps objects in memory for unit tests.

The AWS SDK packages (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)
appear in `package.json`, which is unavoidable, but **no vendor name appears in
code outside `src/modules/storage/`** — the same rule that governs `sms/` and
`notifications/`.

### 2.3 Integration tests run against MinIO

**A deliberate departure from a stated convention.** AGENTS.md says to stub only
at the port boundary, which would mean testing against `FakeObjectStorage`.

This port's entire job is a wire protocol: presigned URL construction, signature
version, path-style versus virtual-host addressing, header canonicalization. A
fake exercises none of it, so with a fake the first real test of the adapter
happens against Hetzner, in production, and its failures are opaque. That class
of bug costs a day each time.

`docker-compose.yml` therefore gains a MinIO service, and the integration suite
runs with `STORAGE_PROVIDER=s3` pointed at it. This is the same reasoning that
already puts real Postgres and real Redis in the suite rather than doubles. Unit
tests continue to use the fake.

### 2.4 ffmpeg

The binary comes from `ffmpeg-static` and `ffprobe-static` rather than a system
package, so a developer on Windows and a Linux container resolve the same way.
Both download a binary in a postinstall script and must be added to the
`pnpm-workspace.yaml` build allowlist.

Invocation is `execFile` with an explicit argument array — never a shell string.
Filenames derive from storage keys, and a shell would make that an injection
surface for no benefit. `fluent-ffmpeg` is not used: it wraps argument building
we do not need, and is barely maintained.

### 2.5 Code organization

```
src/modules/
  storage/
    object-storage.ts            port, UploadTicket, StorageError
    s3-compatible.storage.ts     the one real adapter
    fake-object.storage.ts       in-memory, unit tests
    storage.module.ts            the factory, mirroring SmsModule
  media/
    media-keys.ts                pure key construction (+ spec)
    media.repository.ts          assets, dedupe, abandoned-intent sweep
    media.service.ts             intent, confirm, access rules
    media.controller.ts          operator upload + shared read routes
    dto/media.dto.ts
    promo.ffmpeg.ts              pure argument construction (+ spec)
    media.processor.ts           worker side
    media.module.ts              producer side
    media.worker.module.ts       worker side
  purchases/
    purchases.repository.ts
    purchases.service.ts         entitlement is decided here
    purchases.controller.ts
    purchases.module.ts
```

`media-keys.ts` and `promo.ffmpeg.ts` are pure and unit-tested, following the
precedent of `bookings/domain/` — key layout and encoder arguments are exactly
the kind of thing that is tedious to assert through I/O and trivial to assert
directly.

---

## 3. Data model

### 3.1 `media_assets`

```sql
CREATE TYPE media_status AS ENUM
  ('pending_upload', 'uploaded', 'processing', 'ready', 'failed');

media_assets (
  id              uuid PRIMARY KEY,
  checkin_id      uuid NOT NULL REFERENCES operator_checkins(id),
  operator_id     uuid NOT NULL REFERENCES operators(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  booking_id      uuid REFERENCES bookings(id),
  customer_id     uuid REFERENCES users(id),
  status          media_status NOT NULL DEFAULT 'pending_upload',
  content_hash    char(64) NOT NULL,
  byte_size       bigint NOT NULL,
  original_key    text NOT NULL,
  promo_key       text,
  duration_sec    numeric(6,2),
  failure_reason  text,
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  uploaded_at     timestamptz,
  processed_at    timestamptz
);
```

**The anchor is the check-in, not the booking.** `checkin_id`, `operator_id` and
`location_id` are required; `booking_id` and `customer_id` are nullable. An
operator flying without a booking has somewhere to put the footage, and it
simply reaches no customer. `customer_id` is copied from the booking at intent
rather than joined at read time, so the storage key and the access check do not
depend on the booking still looking the way it did.

`attempts` is the application's own counter, distinct from BullMQ's: it survives
the job being removed and is what the operator's app shows.

### 3.2 `purchases`

```sql
CREATE TYPE purchase_status AS ENUM ('paid', 'refunded');

purchases (
  id                 uuid PRIMARY KEY,
  booking_id         uuid NOT NULL REFERENCES bookings(id),
  customer_id        uuid NOT NULL REFERENCES users(id),
  amount             numeric(10,2) NOT NULL,
  currency           char(3) NOT NULL,
  status             purchase_status NOT NULL DEFAULT 'paid',
  provider           text NOT NULL DEFAULT 'dummy',
  provider_reference text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX purchases_one_paid_per_booking
  ON purchases (booking_id) WHERE status = 'paid';
```

**A purchase covers the whole booking**, unlocking every clip from that session.

`amount` and `currency` are copied from the booking's `price_snapshot` and
`currency`, the same rule that already governs the booking itself: editing a
price must never change what an existing customer owes or paid.

`provider` and `provider_reference` exist from the start, set to `'dummy'` and
null. #5 adds gateway values without a migration, and any row written in the MVP
is permanently identifiable as pre-payment.

The unique index is partial on `status = 'paid'` so a refund can be followed by
a repurchase.

### 3.3 `bookings` addition

```sql
ALTER TABLE bookings ADD COLUMN promo_notified_at timestamptz;
```

A booking's first ready promo notifies the customer; later clips arrive
silently. Deciding that by counting existing `ready` assets would race when two
workers finish together, so it is claimed the same way the readiness scan claims
its rows:

```sql
UPDATE bookings SET promo_notified_at = now()
 WHERE id = $1 AND promo_notified_at IS NULL
RETURNING id;
```

A returned row is the permission to send. Two concurrent finishers, one push.

### 3.4 Integrity guardrails

```sql
CREATE UNIQUE INDEX media_content_hash
  ON media_assets (content_hash) WHERE status <> 'failed';
CREATE INDEX media_assets_booking_idx
  ON media_assets (booking_id, created_at DESC) WHERE booking_id IS NOT NULL;
CREATE INDEX media_assets_operator_idx
  ON media_assets (operator_id, created_at DESC);
```

The hash index is §3.8's integrity requirement in the database rather than in
application code: one file, at most one live asset, therefore at most one
booking. It excludes `failed` so a genuinely botched transfer can be retried
with the same file — a total unique index would let one corrupt upload poison
that video permanently.

**The cost of that index is that a `pending_upload` row holds the lock.** An
operator who requests an upload URL and then closes the app would block that
file forever. §4.3 handles it.

### 3.5 Migration notes

Three migrations. Every partial index predicate must be written with bare column
names — `` sql`status <> 'failed'` `` — because drizzle-kit renders a
table-qualified reference that `CREATE INDEX ... WHERE` rejects. The same text
is repeated verbatim in any `onConflict` target so Postgres can infer the index.

---

## 4. Upload

### 4.1 Intent

```
POST /operators/me/media/upload-intent
  { checkinId, bookingId?, contentHash, byteSize, contentType }
→ { mediaId, url, headers, expiresAt }
```

Validation, in order:

1. The check-in exists, belongs to the calling operator, and is `active`.
2. If `bookingId` is given: the booking belongs to the calling operator and is
   `completed`. Uploads precede the end of a session only by mistake — §3.8's
   procedure is "session ended, then transfer" — and accepting one earlier would
   attach footage to a session still in progress.
3. If `bookingId` is given: the booking's `location_id` equals the check-in's.
   An operator working two locations in a day otherwise has nothing stopping
   footage shot at one being attached to a booking at the other, and the storage
   key — built from the check-in's location — would then disagree with the
   booking it is filed under.
4. `byteSize` does not exceed `MEDIA_MAX_BYTES`.
5. `contentHash` is not already held by a non-failed asset.

Then a `pending_upload` row is written and a presigned `PUT` returned. The
storage key is built by `media-keys.ts`:

```
media/{locationId}/{YYYY-MM-DD}/{customerUserId | 'unassigned'}/{mediaId}/original.mp4
                                                                        /promo.mp4
```

The date segment is the booking's `start_at` — or, with no booking, the upload
time — rendered in `BUSINESS_TIMEZONE` through `common/time/business-day.ts`.
Never from a bare `new Date()`: which *day* a file belongs to is a business-day
question, and a UTC render puts an evening session in Israel on the wrong date.

The location and user segments exist for human browsing and matching, as
requested. **Unguessability comes from the UUIDv7 `mediaId`**, which satisfies
§9's requirement that a leaked URL for one object must not help guess another.
The segments above it are shared by many objects and reveal nothing that the
holder of a signed URL does not already know.

**The hash is checked here, before 200MB crosses the network.** It is declared
by the client, so it is not trusted: §5.1 re-computes it from the bytes actually
received. The cheap check simply runs first.

### 4.2 Confirm

```
POST /operators/me/media/:id/confirm   →   { status: 'uploaded' }
```

The asset must be `pending_upload` and belong to the caller. The service then
calls `head(original_key)` and requires the object to exist at exactly the
declared `byte_size`.

**That check is the reason confirm is a separate call.** Without it a client
could report success having uploaded nothing, and the failure would surface much
later as a worker error with no obvious connection to the session. Here it is
refused immediately, while the operator is still holding the phone.

The row moves to `uploaded` and a `process-media` job is enqueued.

### 4.3 Abandoned intents

Phase 3's `SchedulerProcessor.tick()` gains a third scan:

```sql
UPDATE media_assets
   SET status = 'failed', failure_reason = 'upload_abandoned', updated_at = now()
 WHERE status = 'pending_upload'
   AND created_at < now() - (MEDIA_UPLOAD_ABANDON_MIN minutes)
```

This releases the content-hash lock. Without it, one abandoned intent makes that
video permanently un-uploadable, with no way for the operator to discover why.

---

## 5. Processing

### 5.1 The pipeline

The `media` queue's processor, running in the Phase 3 worker:

1. Claim: `uploaded → processing`, `attempts = attempts + 1`.
2. Download `original_key` to `MEDIA_TEMP_DIR/{mediaId}/`.
3. SHA-256 the downloaded file and compare with `content_hash`.
4. `ffprobe` for duration, recorded on the row.
5. `ffmpeg` to a promo:

```
-ss 0 -i original.mp4 -t {PROMO_DURATION_SEC} -vf scale=-2:{PROMO_HEIGHT}
-c:v libx264 -preset veryfast -crf 26 -c:a aac -b:a 96k
-movflags +faststart -y promo.mp4
```

   `scale=-2:720` preserves aspect ratio and keeps the width even, which H.264
   requires. `+faststart` relocates the index to the front of the file; without
   it the promo will not begin playing until it has fully downloaded, which is
   the whole point of a preview.

6. Upload `promo_key`.
7. `processing → ready`, stamp `promo_key`, `duration_sec`, `processed_at`.
8. If the asset has a `booking_id`, claim that booking's promo notification
   (§3.3); if the claim returns a row, notify the customer. An asset with no
   booking reaches nobody and skips this step entirely — which is the whole
   behaviour of an unbooked flight: stored, never delivered.

The temp directory is removed in a `finally`, on success and on every failure
alike — product design §3.6 calls this out specifically, and a worker that also
transcodes is exactly where a small disk fills up unnoticed.

### 5.2 Failure policy

**A hash mismatch fails immediately and is never retried.** The bytes in storage
are not the bytes the client claimed to send; running them again cannot change
that. `failure_reason = 'hash_mismatch'`.

Everything else — a download blip, a transient ffmpeg failure, storage
unavailability — throws, and BullMQ retries three times with exponential
backoff. On final failure the row becomes `failed` with the reason recorded.

**The operator is notified of a failure; the customer is not.** The operator is
the only party who can act — re-upload, or re-shoot while still at the location
— and nothing has been promised to the customer yet, so telling them a video
they have never heard of has failed creates a support conversation out of
nothing.

### 5.3 Notification keys

Added to `push-templates.ts`:

| Key | Recipient | Trigger |
|---|---|---|
| `PROMO_READY` | customer | the booking's **first** asset reaches `ready` |
| `MEDIA_PROCESSING_FAILED` | operator | an asset reaches `failed` |
| `MEDIA_PURCHASED` | operator | the customer completes a purchase |

`PROMO_READY` carries `bookingId` in the push payload so the app opens the right
screen.

---

## 6. Delivery and entitlement

Every media route returns a short-TTL signed URL, never bytes.

**Promo** is readable by the booking's customer, the operator who shot it, and
an admin. No purchase required — it is the sales pitch.

**Full resolution** goes through exactly one function, which lives in
`PurchasesService` — it is a question about purchases, and putting it there
keeps `MediaService` from growing its own opinion about entitlement:

```ts
// The entire paywall decision for the MVP, deliberately in one place.
//
// 2026-09-16: a purchase costs nothing and calls no gateway (§1.3), so this
// currently means "the customer pressed buy". Sub-project #5 makes the
// purchase real by changing how a purchases row comes to exist — not by
// changing this check, and not by adding a check somewhere new.
assertFullResEntitlement(asset, caller): void
```

- The booking's customer, **with a paid purchase for that booking** — otherwise
  `PURCHASE_REQUIRED` (402).
- The operator who shot it, always. It is their own footage.
- An admin, always.
- An asset that is not `ready` yields `MEDIA_NOT_READY`, not a broken URL.

Concentrating it here is the point. An access rule spread across three
controllers is one that #5 will partially update.

### 6.1 The dummy purchase

```
POST /bookings/:id/purchase   (customer, own booking)
```

The booking must be `completed` and have at least one `ready` asset — there is
nothing to buy otherwise. The row is written with `amount` and `currency`
copied from the booking, `provider = 'dummy'`, `status = 'paid'`, and the
operator is notified. A second purchase for the same booking is refused with
`ALREADY_PURCHASED` rather than silently succeeding, so the client cannot
double-count.

No gateway, no webhook, no signature verification — and correspondingly, **none
of §9's payment-webhook hardening is present or needed yet.** #5 introduces all
of it at once, along with the `pending` state this enum deliberately omits.

---

## 7. Endpoint surface

| Method | Path | Roles | Notes |
|---|---|---|---|
| `POST` | `/operators/me/media/upload-intent` | operator | `200` — reserves, does not create the object |
| `POST` | `/operators/me/media/:id/confirm` | operator | `200` |
| `GET` | `/operators/me/media` | operator | the caller's uploads |
| `GET` | `/bookings/:id/media` | customer, operator, admin | party-scoped, like the booking itself |
| `GET` | `/media/:id/promo` | customer, operator, admin | signed URL |
| `GET` | `/media/:id/full-res` | customer, operator, admin | entitlement per §6 |
| `POST` | `/bookings/:id/purchase` | customer | `201` — genuinely creates |

Seven new protected routes: the authorization matrix goes from 26 rows to 33.

Media reads follow the booking's precedent — two owning parties, so no
`me`-shaped URL and a per-resource ownership check rather than a role check
alone. `/media/:id/*` is the IDOR-sensitive surface here and is covered
explicitly in §10.

---

## 8. Configuration

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_PROVIDER` | `s3` | `s3` \| `fake` |
| `S3_ENDPOINT` | — | Required when provider is `s3` |
| `S3_REGION` | `us-east-1` | Many S3-compatible vendors ignore it but require it present |
| `S3_BUCKET` | — | Required when provider is `s3` |
| `S3_ACCESS_KEY_ID` | — | Required when provider is `s3` |
| `S3_SECRET_ACCESS_KEY` | — | Required when provider is `s3` |
| `S3_FORCE_PATH_STYLE` | `true` | MinIO and most non-AWS vendors need it |
| `MEDIA_MAX_BYTES` | `1073741824` | 1 GB |
| `MEDIA_UPLOAD_URL_TTL_SEC` | `900` | |
| `MEDIA_DOWNLOAD_URL_TTL_SEC` | `300` | §9 wants minutes, not hours |
| `PROMO_DURATION_SEC` | `5` | |
| `PROMO_HEIGHT` | `720` | |
| `MEDIA_UPLOAD_ABANDON_MIN` | `30` | |
| `MEDIA_TEMP_DIR` | `os.tmpdir()/acs-media` | |

The four S3 credentials are conditionally required when `STORAGE_PROVIDER=s3`,
using the same `superRefine` as the SMS4Free credentials: fail at boot rather
than on the first operator's upload after a shoot.

---

## 9. Error model

| Code | Status | Raised when |
|---|---|---|
| `MEDIA_NOT_FOUND` | 404 | No such asset, or the caller is not a party to it |
| `MEDIA_DUPLICATE` | 409 | That content hash is already held by a live asset |
| `MEDIA_TOO_LARGE` | 422 | `byteSize` exceeds `MEDIA_MAX_BYTES` |
| `MEDIA_OBJECT_MISSING` | 409 | Confirm found nothing in storage, or a size mismatch |
| `MEDIA_NOT_READY` | 409 | Promo or full-res requested before processing finished |
| `BOOKING_NOT_COMPLETED` | 409 | Upload intent or purchase against a session not yet ended |
| `PURCHASE_REQUIRED` | 402 | Full-res without a paid purchase |
| `ALREADY_PURCHASED` | 409 | A paid purchase already exists for that booking |

402 requires a new `PaymentRequiredError` in the `DomainError` hierarchy.

`MEDIA_NOT_FOUND` deliberately covers both "does not exist" and "not yours" on
the `/media/:id/*` routes. This differs from the booking rule — where an
unrelated caller gets 403 because they already know the id — because a media id
is not something a third party ever legitimately holds, so confirming one exists
is itself a small leak.

`GET /bookings/:id/media` is a booking-scoped route and keeps the **booking**
convention: `BookingAccessGuard`, 403 for an unrelated caller, 404 for a missing
booking. The two rules coexist because they answer different questions, and each
route follows the rule of the resource in its path.

---

## 10. Testing strategy

Beyond ordinary coverage, these exist because the failure is silent:

1. **A second upload intent with the same content hash is refused**, and a
   *failed* asset releases the hash for a retry. §3.8's core guarantee, and the
   partial-index behaviour that makes it survivable.
2. **Two intents for the same booking both succeed.** The inverse test, pinning
   correction §1.3.3 so nobody reinstates the per-booking unique index.
3. **Confirm refuses when the object is absent or the wrong size.**
4. **A hash mismatch fails without retrying**, proving the retry policy
   discriminates rather than blindly retrying everything.
5. **The promo is at most `PROMO_DURATION_SEC` long, `PROMO_HEIGHT` high, and
   its `moov` atom precedes `mdat`** — probed from the produced file, not
   assumed from the arguments. A silent `+faststart` regression makes previews
   feel broken in a way no unit test would notice.
6. **The temp directory is empty after success and after failure.**
7. **Two workers completing a booking's assets simultaneously send one
   `PROMO_READY`.** The `promo_notified_at` claim, tested like the Phase 3
   readiness scan.
8. **An abandoned `pending_upload` is failed by the tick and its hash becomes
   reusable.**
9. **Full-res is refused with 402 before purchase and permitted after**, and
   **a customer cannot reach another customer's media** — the IDOR row, in the
   authorization matrix and again as a direct test.

Unit-level: `media-keys.spec.ts` pins the key layout including the
`'unassigned'` branch and business-timezone date rendering;
`promo.ffmpeg.spec.ts` pins the argument array.

Integration tests run against MinIO from `docker-compose.yml`, including a real
presigned `PUT` over HTTP, so the adapter's signing is genuinely exercised.

---

## 11. Traps

- **`ffmpeg-static` and `ffprobe-static` download binaries in a postinstall
  script.** pnpm 12 blocks that until approved; both must be added to the
  `pnpm-workspace.yaml` allowlist or a fresh `pnpm install` fails.
- **`scale=-2:720`, not `-1:720`.** H.264 requires even dimensions, and `-1`
  will produce an odd width on some sources and fail the encode.
- **Presigned `PUT` enforces `Content-Type` only if the client sends exactly
  what was signed.** The ticket therefore returns the required headers rather
  than leaving the client to guess, and a mismatch surfaces as a signature
  error that reads as an auth problem.
- **`S3_FORCE_PATH_STYLE` defaults true.** Virtual-host addressing requires
  wildcard DNS for the bucket, which MinIO and most non-AWS vendors do not
  provide; the failure is a confusing DNS error, not a storage error.
- **Never build an ffmpeg command as a shell string.** Filenames derive from
  storage keys. `execFile` with an argument array, always.
- **`head()` on a missing object throws rather than returning null** in the AWS
  SDK. The adapter must catch `NotFound`/404 and return null, or confirm reports
  a server error for the ordinary case of a client that never uploaded.

---

## 12. Known gaps on completion

- **Full-resolution video is effectively free.** A purchase moves no money.
  Anyone who completes a booking can unlock every clip by pressing buy. This is
  deliberate and dated (§1.3.5); it is the single largest thing #5 closes.
- **No refunds, no `pending` purchase state, no webhook verification.** All of
  §9's payment hardening arrives with #5.
- **No media retention or deletion.** Originals accumulate indefinitely. A
  retention policy needs a product decision — how long a customer keeps access
  — before it can be an engineering one.
- **Uploads are single-shot.** A dropped connection restarts the transfer.
  Multipart with resume is the known upgrade; the trigger is operators reporting
  failed uploads more than occasionally.
- **No virus or content scanning** on uploaded media.
- **Third-party privacy in drone footage** (product design §9) remains an
  unaddressed legal question, not an engineering one.
- **No admin media browser.** Support cannot currently look at a customer's
  media without a database query.
