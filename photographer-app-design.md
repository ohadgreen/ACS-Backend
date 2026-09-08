# operator On-Demand Booking App — Technical Design

## 1. System Overview

Two client apps (Customer, operator) on React Native, backed by a Node.js API and Postgres. Core domains:

1. **Presence & Availability** — operators check in, publish 15-min slots
2. **Discovery** — geo search for nearby available operators
3. **Booking** — reserve a slot, handle cancellations/expiry
4. **Session Lifecycle** — pre-session readiness ack, in-progress, completed
5. **Media Pipeline** — upload → watermark → deliver preview → full-res purchase
6. **Payments** — pay-per-photo/session after approval

```
┌─────────────────┐         ┌─────────────────┐
│ Customer App RN  │         │ operator App RN│
└────────┬─────────┘         └─────────┬─────────┘
         │ REST/WebSocket               │
         └───────────┬──────────────────┘
                      │
              ┌───────▼────────┐
              │  API Gateway /   │
              │  Node.js (NestJS)│
              └───────┬────────┘
     ┌─────────────────┼─────────────────────┐
     │                 │                     │
┌────▼─────┐   ┌───────▼──────┐      ┌───────▼───────┐
│ Postgres  │   │ Redis (cache/ │      │ Job Queue      │
│ + PostGIS │   │ geo, pubsub)  │      │ (BullMQ)       │
└──────────┘   └──────────────┘      └───────┬───────┘
                                              │
                              ┌───────────────┼────────────────┐
                        ┌─────▼─────┐   ┌─────▼─────┐   ┌──────▼──────┐
                        │ Push (FCM/ │   │ S3 + image │   │ Payment      │
                        │ APNs)      │   │ processing │   │ provider     │
                        │            │   │ (watermark)│   │ (Stripe)     │
                        └───────────┘   └───────────┘   └─────────────┘
```

## 2. Data Model (core tables)

```sql
operators (
  id, user_id, display_name, bio, rating, gear_tags[],
  price_per_session, stripe_account_id, status  -- offline/online/in_session
)

operator_locations (   -- current check-in
  operator_id, geog GEOGRAPHY(POINT), checked_in_at, active_until
)

availability_slots (
  id, operator_id, start_at, end_at, status  -- open/booked/expired/cancelled
)

bookings (
  id, slot_id, customer_id, operator_id, status,
  -- pending -> confirmed -> customer_ready -> in_progress -> completed -> cancelled/no_show
  created_at, ready_ack_at,
  identity_photo_key,       -- S3 key, private bucket, camera-only capture
  identity_photo_captured_at,
  identity_photo_purged_at
)

media_assets (
  id, booking_id, storage_key, type,  -- preview_watermarked / full_res
  uploaded_at
)

purchases (
  id, booking_id, customer_id, amount, payment_intent_id, status, purchased_media_ids[]
)
```

Key indexing decisions:
- `operator_locations.geog` uses **PostGIS** with a GIST index — `ST_DWithin` for the 300m radius query. This is the single most important infra choice; don't try to hand-roll geo search.
- `availability_slots` indexed on `(operator_id, status, start_at)` for "today's open slots."
- Bookings use a state machine (enum + allowed transitions enforced in application code, not just DB constraint) — this flow has many edge cases (no-shows, late cancellations, slot expiry) that are easy to get wrong.

## 3. Key Flows

### 3.1 operator check-in & slot publishing
- operator app sends check-in with lat/lng → upsert into `operator_locations`, set status `online`.
- operator defines slots for the day (simple UI: pick start times, 15-min granularity, or a "auto-generate slots for next N hours" button for speed).
- A background job expires slots whose `start_at` has passed without a booking.

### 3.2 Discovery
- Customer app sends current lat/lng.
- API: `SELECT ... FROM operator_locations WHERE ST_DWithin(geog, customer_point, 300) AND status='online'`, joined to `availability_slots WHERE status='open' AND start_at::date = today`.
- Cache this query in Redis with short TTL (5-10s) if load is high — for MVP, skip caching, Postgres will handle it fine at low volume.

### 3.3 Booking
- Customer selects a slot → API does a transactional `UPDATE availability_slots SET status='booked' WHERE id=? AND status='open'` (optimistic locking — the `WHERE status='open'` guards against double-booking race conditions). If 0 rows affected, return "slot no longer available."
- Booking created in `pending`/`confirmed` state.

### 3.4 Identity photo (customer verification)
- At booking time, before confirmation, customer app forces a **live camera capture** (no gallery picker) of the customer's face — purpose is in-person identification by the operator, not a deliverable photo.
- Uploaded via pre-signed URL directly to a **separate, private S3 prefix/bucket** from session media — never enters the watermark/delivery pipeline.
- Access scoped server-side to only the operator assigned to that booking, via short-TTL signed URLs generated on request — not cached or permanently downloaded by the operator app.
- **Purge job**: a scheduled worker (same pattern as slot-expiry) deletes the photo from storage and nulls `identity_photo_key`, setting `identity_photo_purged_at`, a fixed short window after the booking reaches `completed` (e.g. 24–48h). No facial-recognition/ML matching — manual human glance only, by design, to keep this feature low-risk.
- One-time consent modal on first use explaining purpose, visibility (operator only), and auto-deletion — shown before first capture, not just buried in ToS.
- Log operator access to identity photos (who viewed, when) for audit/abuse investigation purposes.

### 3.5 Pre-session readiness
- BullMQ delayed job scheduled at `slot.start_at - 5min` → sends push notification "Your session starts soon, confirm you're ready."
- Customer taps confirm → `bookings.status='customer_ready'`, `ready_ack_at` set → push/socket event to operator app so they see it live.
- If no ack within a grace window (e.g. 2 min before start), auto-cancel or flag as at-risk and notify operator — decide this policy early, it's a common support-ticket source.

### 3.6 Media delivery (video)
- operator uploads the full-res, ~1-minute drone video directly to **S3/R2 via a pre-signed URL** (never proxy large video files through your Node server).
- Upload event → BullMQ job on your worker runs an **ffmpeg pipeline**:
  1. **Trim** — cut a short promo clip (a few seconds) from the full video. For MVP, let the operator pick the start point via a simple scrubber UI (drag to a timestamp, fixed clip length e.g. 5-8s) rather than trying to auto-detect the "best" moment — much less engineering for a perfectly adequate result, and gives the operator useful control.
  2. **Watermark** — overlay a watermark on the trimmed clip (ffmpeg's `overlay` filter), output a compressed, lower-res preview file.
  3. Write a `media_assets` row (`type='preview_watermarked'`) pointing at the short clip → notify customer in-app that their preview is ready.
- Full-res original stays private in S3/R2, untouched by watermarking, only accessible after purchase (served via short-lived signed URL for download/streaming). **Stored uncompressed for now** — no re-encoding on the full-res path, since ~1 minute of HD footage is small enough not to justify the added processing/complexity yet. Revisit if source file sizes grow (e.g. 4K) or storage/egress costs become material.
- Processing runs on the same worker as your job queue (see §4) — clean up the downloaded/intermediate video files from local disk immediately after each job completes; don't let temp video files accumulate on a small VM.

**Future enhancement (not MVP)**: an auto-editing pass on the full-res video — trimming stale/low-motion moments, appending a branded outro/logo — could slot in as an additional ffmpeg job stage between upload and "ready for sale," without changing the overall pipeline shape (still upload → process → store). Likely candidates when you get there: basic motion/scene-change detection (ffmpeg's scene filter or a simple frame-diff heuristic) for trimming, and a static logo overlay/concat for the outro — both doable without a heavier video-ML dependency. Worth deferring until you have real footage samples to tune against; premature to build against assumptions now.

### 3.7 Payment
- Use **Stripe Connect** (operators are your marketplace "connected accounts") — this handles the split-payment/payout problem for you instead of you building ledger logic.
- Customer selects photos to buy → create PaymentIntent → on success webhook, mark `purchases` row paid, grant access to full-res `media_assets`, trigger payout logic to operator's connected account.

### 3.8 Operator video retrieval & session association
Drone operator uses a **dedicated Android tablet** (locks environment, avoids per-device permission/storage variability, sidesteps DJI's lack of iOS MSDK support entirely since this flow doesn't use the DJI SDK at all).

- Operator transfers the video from drone to tablet using **DJI's own Fly app** — no custom drone-SDK integration needed for MVP. DJI Fly saves to a fixed, non-configurable location (typically `DCIM/DJI Album` on shared storage).
- Your app reads that location via **`expo-media-library`** (standard Expo module, no native code, no ejecting) — `getAlbumAsync('DJI Album')` + `getAssetsAsync({ mediaType: 'video', createdAfter, album })`.
- **Auto-match, don't manual-browse:**
  1. Operator taps **"Session ended"** in-app the moment a shoot wraps → records `session_end_at` on the booking.
  2. After DJI Fly transfer completes, app queries the album for video assets with `creationTime > session_end_at` (small buffer for transfer lag).
  3. **Exactly one match** → confirmation screen (thumbnail, duration, timestamp, alongside the customer/booking name) → operator taps one explicit "confirm & upload." Never silent auto-upload.
  4. **Zero or multiple matches** → forced disambiguation from just the candidate set (never a raw file browser).
- **Integrity guardrails**: `media_assets.booking_id` unique constraint; reject re-upload of an already-consumed file by content hash — a video can never end up silently attached to two bookings.
- After backend confirms upload success, optionally auto-delete the local tablet copy via `MediaLibrary.deleteAssetsAsync` (Android shows a system consent prompt on modern versions — expected).
- **Operating procedure, not just software**: transfer and confirm after *every single session*, before the next flight — collapses the "multiple candidates" case to near-zero for free.
- Clearing the drone's own SD card/internal storage remains a manual step by the operator in DJI Fly for MVP — true drone-SDK automation (list/download/delete directly from the aircraft) is a distinct, harder future workstream (Android-only, requires confirming your specific aircraft has MSDK support) — not required to ship.

## 4. Tech Stack Recommendations

| Layer | Choice | Why |
|---|---|---|
| Mobile | React Native + Expo (managed workflow) | Push notifications, camera, location, OTA updates all handled; ejecting later is possible if needed |
| Backend | Node.js + NestJS (or plain Express if you want less ceremony) | Structure pays off once you have 5+ domains; Express is fine if you want to move faster and are disciplined |
| DB | Postgres + PostGIS extension | Geo queries are core to the product — don't reach for a separate geo DB |
| Cache/pubsub | Redis | Session state, live "operator went offline" events via pub/sub to sockets |
| Realtime | Socket.io or simple polling for MVP | Live status (ready ack, in-progress) — polling every 5-10s is a legitimate MVP shortcut |
| Storage | S3 (or Cloudflare R2 for cheaper egress) | Pre-signed URLs for direct upload/download |
| Video processing | ffmpeg (via `fluent-ffmpeg` or CLI calls) in a worker | Trim + watermark pipeline; runs as a BullMQ job, not inline in the request |
| Operator media retrieval | `expo-media-library` | Reads DJI Fly's shared-storage album directly; no drone SDK or native module needed for MVP |
| Jobs/scheduling | BullMQ (Redis-backed) | Slot expiry, reminder notifications, watermark jobs |
| Push | Expo Notifications (wraps FCM/APNs) | Fastest path from RN |
| Payments | Stripe Connect | Marketplace payouts solved out of the box |
| Auth | Firebase Auth, Clerk, or Auth0 | Don't build your own auth for MVP |

## 5. Getting a Fast MVP Running

**Cut scope ruthlessly first.** The full spec has ~6 subsystems; an MVP should prove the core loop (discover → book → shoot → preview → pay) with everything else stubbed.

**Suggested MVP cuts:**
- Single city/area, no need for sharding or heavy geo scale — a plain PostGIS query is plenty.
- Skip real-time sockets; poll every 5-10s for status changes.
- Skip auto-slot-expiry edge cases initially; handle manually/via a simple cron.
- Watermarking: a fixed-position text/logo overlay via Sharp, run synchronously on upload for v0 — optimize to async workers later.
- Payments: Stripe Checkout (hosted page) instead of building custom payment UI — much faster to ship, upgrade to Payment Sheet/Elements later.
- No operator vetting/rating system initially — manually onboard your first operators.
- One time zone, no multi-day slot planning UI complexity — "today only" slots.

**Suggested build order (roughly 1 sprint each if solo/small team):**
1. **Data model + auth** — Postgres schema, PostGIS extension, Firebase/Clerk auth wired into both apps.
2. **operator check-in + slot CRUD** — simplest possible screens; this validates your core tables.
3. **Discovery + booking** — the geo query, slot locking transaction, booking states. This is the technical heart of the app — get it right before adding polish.
4. **Notifications + readiness ack** — Expo push, BullMQ delayed job.
5. **Upload + watermark pipeline** — S3 pre-signed URLs, Sharp watermarking, delivery to customer app.
6. **Payments** — Stripe Checkout + Connect payouts.
7. **Polish pass** — ratings, cancellation policies, edge-case handling (no-shows, expired slots, refunds).

**Infra shortcuts for speed:**
- Use a managed Postgres with PostGIS pre-enabled (Supabase, Neon, or RDS) rather than self-hosting.
- Deploy the Node API on Railway/Render/Fly.io instead of provisioning your own infra — trivial to migrate to AWS/ECS later once you have real load.
- Use Expo's EAS Build/Submit to avoid wrestling with native build pipelines early on.

**What NOT to build custom in v1:** auth, payments UI, geo indexing, native push plumbing, video processing. All have mature managed solutions — every hour spent reinventing these is an hour not spent validating whether operators and customers actually want this.

## 6. Risks/Edge Cases Worth Deciding Early

- **Double-booking race**: solved by the conditional `UPDATE ... WHERE status='open'` pattern above — don't rely on app-level locking alone.
- **No-show policy**: define whether operator or customer eats the cost, and whether it affects future booking privileges.
- **Slot timing drift**: what happens if the operator is late checking a customer in — does the 15-min slot shrink or shift?
- **Preview vs. full-res ownership**: make clear in ToS that watermarked previews are provided regardless of purchase, but full-res requires payment — avoids disputes.
- **Cancellation windows**: how close to session start can either party cancel without penalty.
- **Identity photo retention**: don't skip the purge job — treat it as core to the feature, not a follow-up task, given it's biometric-adjacent data.
- **Wrong video assigned to customer**: mitigated by the auto-match + mandatory confirm/disambiguate flow (§3.8) plus a DB-level uniqueness constraint — but only holds if operators follow the "transfer after every session" procedure; worth reinforcing in operator onboarding, not just relying on the software.

## 7. Payments — Israel-Specific Note

Stripe (and Stripe Connect, needed for operator payouts) does **not support Israeli-registered businesses or connected accounts** — confirmed against Stripe's current supported-country list. Practical options:
- **Rapyd** — Israeli-founded, supports Israeli merchants and has marketplace disbursement tooling; the most direct fit for this app's needs.
- Israeli gateways (**Tranzila**, **Max by Hyp**, **PayMe**) — support cards plus local methods like **Bit** and **Paybox**, which Israeli customers commonly expect, but have weaker/no marketplace-payout tooling — likely means building operator payout logic yourself or handling payouts manually early on.
- Incorporating outside Israel (e.g. via Stripe Atlas) unlocks Stripe for the platform entity, but doesn't solve operator-side payouts unless operators also have foreign entities/accounts — not realistic for individual local operators.

**MVP recommendation**: pick one Israeli gateway supporting cards + Bit for the customer-facing checkout; handle operator payouts manually (bank transfer, simple admin tool) until volume justifies automating via Rapyd or similar.

## 8. Authentication & Authorization

**Per-role auth method:**
- **Customer** — phone + OTP (no password), as decided earlier. Optional anonymous browsing, phone verification required at booking/payment.
- **operator/operator** — **username + password**. Since these are vetted, approved accounts (not open self-serve like customers), provision them via an **admin-issued invite** (admin creates the account or approves a request, system sends a one-time setup link to set the password) rather than open self-registration with a password field — reduces spam/fake signups against a role that needs manual review anyway.
- **Admin** — username + password, provisioned out-of-band only (never via app signup), as decided earlier.

Passwords: hash with **argon2** (or bcrypt if you want the more battle-tested/simpler default) — never store plaintext, never roll your own hashing.

**Token strategy — short-lived access + revocable refresh:**
- **Access token (JWT)**: short expiry (e.g. **15 minutes**). Every protected endpoint validates signature + expiry + embedded role. Short expiry means a suspended/rejected operator's access dies quickly on its own, without needing instant revocation infrastructure.
- **Refresh token**: longer-lived (e.g. 30 days), but **not** a bare JWT — store it (hashed) server-side so it's revocable:
  ```sql
  refresh_tokens (
    id, user_id, token_hash, device_info,
    created_at, expires_at, revoked_at
  )
  ```
  Suspending a operator/operator = revoke their refresh tokens immediately (`revoked_at = now()`); their current access token still works until it naturally expires (≤15 min), then refresh fails and they're locked out — a good balance of "fast enough" revocation without needing a live token-blocklist for MVP.
- On refresh, re-check current status (`operators.status = 'approved'`) before issuing a new access token — this is what actually enforces "approved users only" on an ongoing basis, not just at login.

**Device-side storage**: use **`expo-secure-store`** (Keychain on iOS, Keystore on Android) for tokens — never `AsyncStorage`, which is unencrypted.

**Login endpoint hardening**: rate-limit login attempts (e.g. `express-rate-limit` or a Redis-backed limiter) and lock an account after repeated failures — this endpoint is the one most likely to see credential-stuffing/brute-force attempts since it's password-based, unlike the OTP-based customer flow.

**Baseline for every endpoint regardless of role**: HTTPS only, JWT signature + expiry + role check as middleware (not per-route copy-paste), and 401/403 distinguished (not authenticated vs. authenticated-but-wrong-role) so client error handling stays sane.

## 9. Additional Security Concerns

**Authorization, not just authentication** — every endpoint must check *ownership*, not just role. E.g. `GET /bookings/:id` must verify `booking.customer_id === token.user_id`, not just "any authenticated customer." This class of bug (Broken Object-Level Authorization / IDOR) is one of the most common real-world API vulnerabilities and easy to miss when testing only against your own data — especially critical on the identity-photo endpoint.

**Pre-signed URLs need their own scrutiny:**
- Unguessable object keys (UUIDs, not sequential IDs or predictable patterns like `booking_id.mp4`) so a leaked URL for one file doesn't help guess another.
- Short expiry (minutes, not hours) — especially for identity photos and purchased full-res video.
- Validate content-type and size limits server-side before issuing an upload URL — don't let it be a blank check for arbitrary uploads.

**Payment webhook validation** — verify the webhook signature (Stripe/gateway-provided) on every incoming payment event. Without this, anyone who finds the webhook URL could POST a fake "payment succeeded" and get free access to purchased video.

**OTP abuse (SMS bombing)** — rate-limit "send OTP" per phone number *and* per IP, and use the provider's built-in abuse protection (Twilio Verify/Firebase Auth both have it) — otherwise it's an easy vector for harassing a number you don't own or running up your SMS bill.

**Location spoofing** — a customer or operator could mock-GPS their position, affecting discovery/check-in integrity. Not worth heavy engineering for MVP; note mock-location detection APIs exist on both platforms if this becomes a real abuse pattern later.

**Refresh token rotation** — issue a new refresh token on each use and invalidate the old one; don't allow indefinite reuse of the same refresh token. A revoked/already-used token being presented again is a strong theft signal — force-invalidate that user's session when it happens.

**Third-party privacy in drone footage** — bystanders will inevitably be captured without consent. A genuine privacy/legal exposure in many jurisdictions (similar consideration to the identity-photo discussion earlier) — worth a short legal check on disclosure/ToS obligations before launch, not an engineering fix.

**Secrets & infra hygiene** — no API keys/secrets in git, environment variables via your host's secret manager, `npm audit` in CI, TLS-only everywhere including internal calls.
