# Architecture

The cross-cutting shape of the API (`Agrawal_Backend/`). Module-specific rules live in `modules/`; this file holds only what every module shares.

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 24 LTS | Matches the repo's local toolchain. |
| Language | TypeScript, `strict: true`, `noUncheckedIndexedAccess: true` | ESM (`"type": "module"`), like the repo root. |
| HTTP | Express 5 | Express 5 forwards rejected promises from async handlers to the error middleware; no wrapper needed. |
| Validation + contract | zod | Every request body, query and params object and every response body is a zod schema. OpenAPI 3.1 is generated from those schemas with `@asteasolutions/zod-to-openapi`. At install, confirm the generator's supported zod major and pin zod to it. |
| Database | PostgreSQL 18 on RDS (`db.t3.small`, single-AZ; ADR-0029) | Extensions: `pg_trgm`, `citext`. |
| ORM | Prisma, **`prisma` and `@prisma/client` pinned to the same exact stable version** | ADR-0014 §13: an unpinned `prisma` resolves to a release candidate. Use Prisma's multi-file schema: one `.prisma` file per module under `prisma/schema/`. Follow Prisma's current Express guide for the driver-adapter setup of the pinned major. |
| Jobs | pg-boss | Queue lives in the same Postgres. Jobs are enqueued inside the domain transaction where the domain change happens. |
| Logging | pino + pino-http | JSON logs, request ID on every line, redaction list below. |
| Security headers | helmet | Default config; API serves JSON only. |
| Tests | vitest + supertest | Against a real Postgres. |
| Phone/session auth | SMS OTP via Amazon SNS (backend-generated, HMAC-SHA256 hashed) | `POST /v1/auth/otp` delivers 6-digit code via Amazon SNS; `POST /v1/auth/session` exchanges `{ client, authentication: { kind: "SMS_OTP", phoneE164, otp } }` for an opaque session (HTTP-only cookie for WEB, 90-day sliding bearer token for MOBILE). ADR-0034; lifecycle defined in ADR-0033. |
| Payments | `razorpay` (Razorpay's first-party Node SDK) for orders, payments, refunds | Webhook signatures verified with `node:crypto` HMAC over the raw body. |
| Storage | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | Private bucket; presigned GET URLs. |
| Image processing | `sharp` | Re-encode every upload. |
| Romanization | `@google-cloud/translate` v3 `TranslationServiceClient.romanizeText` | Devanagari→Latin only (ADR-0017 §7). |
| Push (Stage 2) | `firebase-admin` messaging | FCM only (no Web Push). |
| Image screening (Stage 2) | Sightengine REST `POST https://api.sightengine.com/1.0/check.json`, called with `fetch` | Not the stale Node SDK (ADR-0014 §6). |
| Pass signing (Stage 2) | `node:crypto` Ed25519 | No third-party crypto. |

Install every dependency at an exact version (`--save-exact`). No `^` ranges in `Agrawal_Backend/package.json`.

## Repository layout

```
Agrawal_Backend/
  package.json            # its own package; standalone folder, not a workspace
  tsconfig.json
  Dockerfile
  docker-compose.yml      # local: postgres only
  openapi.json            # generated, committed, checked for drift in CI
  prisma/
    schema/
      base.prisma         # generator + datasource
      identity.prisma
      payments.prisma
      registration.prisma
      register.prisma
      media.prisma
      officer.prisma
      notifications.prisma
      noticeboards.prisma
      blood-sos.prisma
      events.prisma
    migrations/
    sql/                  # raw SQL migrations Prisma cannot express (triggers, grants, partial indexes)
  src/
    main.ts               # boot: config → db → jobs → http server
    app.ts                # createApp(deps): express app factory used by main and tests
    config.ts             # zod-validated env
    db.ts                 # Prisma client
    jobs.ts               # pg-boss instance, registerAllWorkers()
    clock.ts              # Clock port: now(); tests inject a fake clock
    logger.ts             # createLogger(): pino with the redaction list; createApp wraps any supplied logger with it
    http/
      errors.ts           # AppError, error codes, error middleware
      validate.ts         # validate({ body, query, params }) middleware
      auth.ts             # requirePrincipal / requireMember / requireRole
      csrf.ts
      rate-limit.ts
      idempotency.ts
      request-id.ts
    adapters/             # the only files that talk to vendors
      firebase.ts         # PhoneTokenVerifier, PushSender
      razorpay.ts         # PaymentGateway
      s3.ts               # ObjectStore
      sightengine.ts      # ImageScreener
      translate.ts        # Romanizer
      postal-pincode.ts   # PincodeDirectory
    modules/
      identity/
      payments/
      registration/
      register/
      media/
      officer/
      notifications/
      noticeboards/
      blood-sos/
      events/
    openapi/
      registry.ts
      generate.ts         # writes openapi.json
  test/
    setup.ts              # migrate a fresh schema per test file, truncate between tests
    fakes/                # in-memory implementations of every adapter port
```

Each `modules/<name>/` folder contains:

```
index.ts        # the module's public interface: the ONLY file other modules import
routes.ts       # express Router; mounted in app.ts
service.ts      # domain logic; may be split into several files
schemas.ts      # zod request/response schemas, registered with the OpenAPI registry
jobs.ts         # pg-boss workers and job names (if any)
*.test.ts       # tests next to the code
```

## The module boundary

- A module owns its tables. Only that module's code reads or writes them through Prisma. Another module that needs the data calls the owner's `index.ts`.
- A module imports another module only through `modules/<other>/index.ts`. Enforce with ESLint `no-restricted-imports` patterns (`src/modules/*/!(index).ts` from outside the module). CI fails on a violation.
- Cross-module work inside one transaction: the owner's interface functions accept an optional Prisma transaction client (`tx`) and use it when given. Example: Registration's completion calls `register.createMemberWithLink(tx, …)` and `payments.markConsumed(tx, …)` in a single `prisma.$transaction`.
- **Register is the only module that decides what a viewer may see about a Member** (invariants 16, 20, 22). Every other module that shows a Member — a Report author, a Blood SOS donor, a Business Listing owner — asks Register for a projection; none selects Member columns directly.
- Vendor calls happen only in `src/adapters/`. Each adapter implements a port (a TypeScript interface) declared in `adapters/ports.ts`; modules receive ports through `createApp(deps)`. Tests pass the fakes in `test/fakes/`.

Module dependency direction (an arrow means "may call"):

```
identity ← (everyone, via http/auth.ts)
registration → payments, register, media, officer(flags)
register → media, officer(processing record), notifications
officer → register, media, payments, noticeboards, blood-sos
noticeboards → register, payments, media, notifications, officer
blood-sos → register, notifications, officer
events → register, officer
notifications → (adapters only)
payments → (adapters only; emits events consumed by registration, noticeboards)
```

Payments must not import Registration or Noticeboards. It announces a captured or refunded payment by enqueueing a job named after the payment's `purpose` (`payments.captured.REGISTRATION`, `payments.captured.BUSINESS_LISTING`, `payments.refunded.*`); the owning module registers the worker.

## Configuration

`src/config.ts` parses `process.env` with zod at boot and exits non-zero listing every missing or malformed variable. Nothing else reads `process.env`.

| Variable | Example / default | Purpose |
|---|---|---|
| `NODE_ENV` | Required: `development` \| `test` \| `production` | No config default; deployment sets `production` explicitly. |
| `APP_ENV` | `local` \| `staging` \| `production` | Distinct from NODE_ENV; selects vendor projects. |
| `PORT` | `3000` | |
| `DATABASE_URL` | | App role (restricted grants, see Processing Record). |
| `DATABASE_MIGRATION_URL` | | Owner role, used only by `prisma migrate deploy`. |
| `WEB_ORIGINS` | Required; no default | Comma-separated exact origins for CORS and CSRF. |
| `SESSION_TTL_WEB_DAYS` | `30` | Sliding. |
| `SESSION_TTL_MOBILE_DAYS` | `90` | Sliding. |
| `FIREBASE_PROJECT_ID` | | FCM push notifications only. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | | From SSM (FCM push notifications only). |
| `SMS_PROVIDER` | `console` | `sns` (required in production) or `console` (local/dev only; rejected in production). |
| `SNS_SMS_SENDER_ID` | | DLT-approved 6-character sender ID header. |
| `SNS_SMS_ENTITY_ID` | | DLT Principal Entity ID (PEID). |
| `SNS_SMS_TEMPLATE_ID` | | DLT Content Template ID. |
| `SNS_SMS_OTP_MESSAGE` | | Exact DLT-approved message template containing the literal `{otp}` placeholder. |
| `OTP_HMAC_KEY` | 32+ bytes, base64 | HMAC-SHA256 key for hashing OTP codes in `OtpChallenge`. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | | Test keys on staging, live on production. |
| `RAZORPAY_WEBHOOK_SECRET` | | |
| `REGISTRATION_PAYMENT_PAISE` | `100` | ₹1 (ADR-0016). |
| `REGISTRATION_PAYMENT_REQUIRED` | `true` (fail-closed) | Only explicit `false` enables unpaid registration for the controlled pilot; the flag is server-side policy. |
| `BUSINESS_LISTING_FEE_PAISE` | `4900` | ₹49 (ADR-0016). |
| `PAYMENT_IDENTITY_HMAC_KEY` | 32 random bytes, base64 | Hashes VPAs/card ids for matching. |
| `S3_BUCKET` / `AWS_REGION` | `ap-south-1` | |
| `MEDIA_URL_TTL_SECONDS` | `3600` | Presigned GET lifetime. |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_APPLICATION_CREDENTIALS_JSON` | | Romanization. |
| `IMAGE_SCREENING_ENABLED` | `false` | Stage 1 `false`; M12 flips it. |
| `SIGHTENGINE_API_USER` / `SIGHTENGINE_API_SECRET` | | Stage 2. |
| `EVENT_PASS_SIGNING_KEYS` | JSON `[{kid, privateKeyPem}]` | First entry signs; all verify. Stage 2. |
| `RETENTION_DAYS_PAYMENTS` | `2920` | ADR-0026 §5: eight years, covering GST 72 months and the income-tax reassessment window. |
| `RETENTION_DAYS_CONSENT_AND_LOGS` | `365` | ADR-0005 Rule 8(3), one year minimum. |
| `REGISTRATION_ABANDON_AFTER_HOURS` | `24` | |
| `JOIN_REQUEST_EXPIRY_DAYS` | `14` | |
| `JOIN_REQUESTS_PENDING_MAX_PER_FAMILY` | `10` | |
| Stage 2 tuning | see each module | Reports threshold, suspension length, posting cap, Blood SOS ladder, density floor, donor cooldown, archival escalation. |

Tuning values live in config with the defaults given in module files, never as literals in code.

## HTTP conventions

- All routes under `/v1`. JSON only; reject other `Content-Type`s on bodies with `415` (except the media upload and the Razorpay webhook).
- Field names `camelCase`. Timestamps ISO-8601 UTC strings (`2026-09-22T04:30:00.000Z`). Calendar dates `YYYY-MM-DD`. Money is `{ amountPaise: number, currency: "INR" }`, never floating rupees.
- Internal IDs are UUIDv7 strings generated in the app (`uuid` package `v7()`). The Family ID (`AGR-492001-00017`) is a separate public identifier, `Family.publicId`.
- Enums are `SCREAMING_SNAKE_CASE` strings.
- Pagination: cursor-based. Query `?cursor=<opaque>&limit=<1..50, default 20>`. Response `{ items: [...], nextCursor: string | null }`.
- Language: clients send `Accept-Language: en` or `hi`. Error `message` is localized from a server-side `{en, hi}` table keyed by error code; clients may use `code` to render their own copy.

### Authentication sessions

Authentication is backend-authoritative for both WEB and MOBILE via SMS OTP (ADR-0034; lifecycle defined in ADR-0033):

1. `POST /v1/auth/otp`: Accepts `{ client: "WEB" | "MOBILE", phoneE164: string }`. Generates a cryptographic 6-digit OTP (TTL 300s, max 5 attempts, 30s resend cooldown, rate limits 5/hour per phone and 20/hour per IP), hashes it with HMAC-SHA256 using `OTP_HMAC_KEY`, stores it in Prisma model `OtpChallenge`, and dispatches it via Amazon SNS (or logs to console if `SMS_PROVIDER=console` in development). Returns `202 Accepted` with `{ expiresInSeconds: 300, resendAfterSeconds: 30 }`.
2. `POST /v1/auth/session`: Accepts `{ client: "WEB" | "MOBILE", authentication: { kind: "SMS_OTP", phoneE164: string, otp: string } }`. Verifies the code against the active `OtpChallenge`. Upon verification, resolves the principal: an active Member gets a Member session, an archived Member is denied (`403 PHONE_BELONGS_TO_ARCHIVED_MEMBER`), and an unverified number opens or resumes Registration as an Applicant. Sets an HTTP-only `sid` cookie for WEB and returns a bearer token for MOBILE (90-day sliding TTL).
3. Session restore & revocation: `/v1/auth/me` restores the current principal, and `DELETE /v1/auth/session` revokes it.

Auth error codes: `OTP_INVALID` 401, `OTP_ATTEMPTS_EXCEEDED` 429, `OTP_DELIVERY_FAILED` 502, `RATE_LIMITED` 429, `VALIDATION_FAILED` 400.

### Error envelope

```json
{ "error": { "code": "DUPLICATE_HEAD", "message": "…", "details": { } }, "requestId": "…" }
```

`AppError(code, httpStatus, details?)` is the only thrown error type in services. The error middleware maps: `AppError` → its status; zod failure and malformed JSON (`entity.parse.failed`) → `400 VALIDATION_FAILED`; oversized JSON (`entity.too.large`) → `413 PAYLOAD_TOO_LARGE`; Prisma unique violation not already mapped → `409 CONFLICT`; anything else → `500 INTERNAL` with no internals leaked, logged at `error` with the request ID. Parser failures are client errors and are not logged as unhandled server errors.

Shared codes: `VALIDATION_FAILED` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429 (with `Retry-After`), `IDEMPOTENCY_KEY_REUSED` 422, `INTERNAL` 500, `UPSTREAM_UNAVAILABLE` 503. Module-specific codes are listed in each module file. Every code appears in `src/http/errors.ts` with its `{en, hi}` message.

### Idempotency

Every `POST` that creates a resource or moves money accepts an `Idempotency-Key` header (UUID). Mark those routes with `idempotent()` middleware. Table `IdempotencyRecord(principalKey, key, requestHash, responseStatus, responseBody, responseHeaders, createdAt)`, unique `(principalKey, key)`, keeps successful 2xx responses for 24 hours from completion. A null response status reserves the key while its operation runs: the same request gets `409 CONFLICT` while in flight, and a different request hash gets `422 IDEMPOTENCY_KEY_REUSED`. Completed 2xx responses replay their status, body and application headers. Non-2xx responses release the reservation and are not cached, so a later retry may execute again. The web and Flutter clients generate one key per user action and reuse it on retry.

`IdempotencyStore` requires `find`, `claim`, `complete`, `release`, and `purge`; `PrismaIdempotencyStoreAdapter` is the sole persistent implementation. Claim, completion, release, and purge are mandatory parts of the same lifecycle contract—middleware has no optional-method or fallback-store path.

### CORS and CSRF

- CORS: `cors({ origin: WEB_ORIGINS (exact match), credentials: true })`. The Flutter app is not a browser and needs no CORS.
- CSRF (cookie sessions only; `csurf` is archived, ADR-0014 §12): for any unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) authenticated by the `sid` cookie, require an `Origin` header exactly equal to one of `WEB_ORIGINS`; otherwise `403 FORBIDDEN`. Bearer-authenticated requests skip the check. JSON-only bodies force a CORS preflight for cross-origin writes, which is the second layer.
- **The web client and the API must be same-site** (subdomains of one registrable domain, e.g. `register.<domain>` and `api.<domain>`) or `SameSite=Lax` cookies will not be sent on `fetch`. The domain is an open Operator fact (`open-questions.md`); M0 cannot finish without it.

### Rate limiting

`src/http/rate-limit.ts` exports `rateLimit({ name, key: (req) => string, limit, windowSeconds })`. Storage is the table `RateLimitBucket(name, key, windowStart, count)` with an atomic `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`; a daily job deletes buckets older than two days. Limits survive restarts and are shared by every process. Exceeding a limit returns `429 RATE_LIMITED` with `Retry-After`. Default limits are listed in `modules/identity.md`; each module lists its own.

## Jobs

- One pg-boss instance is started in every API process. `WORKERS_ENABLED=false` disables local worker and schedule registration only; pg-boss remains available for enqueueing jobs for separate workers.
- Job names are `<module>.<verb>` (`registration.expireJoinRequest`). Each module registers its workers in its `jobs.ts` via `registerWorkers(boss, deps)`.
- Payment events use the transactional `PaymentOutboxJob` for dispatch and recovery. Other modules retain their existing enqueue and recovery boundaries.
- Every worker is idempotent: it re-reads current state and exits quietly if the work is already done. Retries: `retryLimit: 5`, `retryBackoff: true`.
- Scheduled jobs (`boss.schedule`, cron in `Asia/Kolkata`):

| Job | Schedule | Module |
|---|---|---|
| `bloodSos.processPending` | every minute | blood SOS |
| `media.screenBacklog` | every 5 min | media |
| `payments.reconcile` | every 10 min | payments |
| `registration.abandonIdle` | every 15 min | registration |
| `noticeboards.endSuspensions` | every 15 min (Stage 2) | noticeboards |
| `registration.expireJoinRequests` | hourly | registration |
| `noticeboards.expireListings` | hourly (Stage 2) | noticeboards |
| `noticeboards.escalateArchivals` | hourly (Stage 2) | noticeboards |
| `media.gcOrphans` | daily 02:00 | media |
| `media.purgeQuarantine` | daily 02:15 | media |
| `register.purgeRestricted` | daily 03:00 | register |
| `officer.purgeProcessingRecords` | daily 03:15 | officer |
| `identity.purgeSessionsAndBuckets` | daily 03:30 | identity |
| `http.purgeIdempotency` | daily 03:45 | (shared) |

Timed per-entity work (a Blood SOS widening step, a join request's expiry) uses `send` with `startAfter`, not a cron scan, and the cron scan exists as a backstop.

## Time

All storage in UTC (`timestamptz`). "Today" and "a day" mean the **IST calendar day** (`Asia/Kolkata`): the adult check (age ≥ 18 on today's IST date), the daily posting cap. `clock.ts` exposes `now()` and `todayIst()`; nothing calls `new Date()` directly outside it, so tests can move time. The one exception is retention purging: the purge functions compare `retain_until` with the database's `now()`, so the app role cannot make rows expire early by passing a later time.

## The Processing Record

An append-only audit table owned by the Officer module (see `modules/officer.md` for the action list). Every Officer action, every Officer read of Member-only data, every Erasure, every refund and every consent change writes one row, **in the same transaction** as the action. It is what ADR-0013 §7 required in place of direct database access, and what DPDP requires as a processing log.

Append-only is enforced by the database, not by convention (raw SQL migration in `prisma/sql/`):
- The app role (`DATABASE_URL`) has `INSERT, SELECT` on `processing_record` and no `UPDATE`/`DELETE`.
- A trigger raises on `UPDATE`, and on `DELETE` of any row whose `retain_until` is in the future; the purge job deletes expired rows by calling the owner-owned `SECURITY DEFINER` function `public.purge_expired_processing_records()`, the only thing the app role may execute to delete.

## Logging

pino with a redaction list covering: `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, the device token in `/v1/me/devices/:token` (URL and params), `*.firebaseIdToken`, `*.phoneE164`, `*.vpa`, `*.dateOfBirth`, `*.address*`, `*.bloodGroup`, `*.nominee*`, and every request body on `/v1/registration*`, `/v1/me*` and `/v1/officer*`. Log the route, status, duration, request ID and principal ID — never Member data. Logs are operational and rotate; they are **not** the processing record.

## Testing

- Integration tests hit the real Express app (`createApp(fakes)`) with supertest against a real Postgres. Each test file gets a fresh schema; tables are truncated between tests. No mocking of Prisma.
- Vendors are replaced by the fakes in `test/fakes/`: `FakePhoneTokenVerifier` (token string → phone), `FakePaymentGateway` (records orders; a helper emits signed webhook payloads), `FakeObjectStore`, `FakeImageScreener`, `FakeRomanizer`, `FakePincodeDirectory`, `FakePushSender` (records sends; can mark tokens invalid).
- Time is moved with the fake clock; pg-boss jobs are run synchronously in tests via a `drainJobs()` helper that executes due jobs against the fake clock.
- Every invariant in the README's map has a test named `invariant N: …`. Each module file ends with its required tests.
- One contract test per vendor adapter using a recorded real response (Razorpay webhook body + signature from the docs, a Firebase token decode shape, a postalpincode response). Adapters are the only code allowed to break when a vendor changes.

## OpenAPI and clients

- `npm run openapi` (in `Agrawal_Backend`) writes `openapi.json` from the zod registry. CI regenerates it and fails if the committed file differs.
- Web: `openapi-typescript` generates `Agrawal_Frontend/apps/web/src/api/schema.d.ts`; the web uses `openapi-fetch` with `credentials: "include"`.
- Flutter: `openapi-generator` with the `dart-dio` generator writes `lib/core/api/generated/` at the repository root. The app's existing repositories (`*_repository.dart`) get HTTP implementations that call the generated client; their in-memory implementations stay for tests.
- Each client generates its own code in its own folder: `npm run openapi` in `Agrawal_Backend/`, the web generator in `Agrawal_Frontend/apps/web`, and `tool/generate_openapi_client.sh` at this repository's root.

## Deployment

### Environments

| | Staging | Production |
|---|---|---|
| Compute | Docker Compose stack `api-staging` on the shared EC2 `t3.small` | Stack `api-prod` on the same instance |
| Database | RDS instance, database `agrawal_staging`, its own roles | Same RDS instance, database `agrawal_prod`, its own roles |
| Firebase & SMS | FCM for push; Amazon SNS test/console | FCM for push; Amazon SNS live with DLT approved template |
| Razorpay | Test keys, test webhook | Live keys, live webhook |
| S3 | Bucket `…-media-staging` | Bucket `…-media-prod` |
| Host | `staging-api.<domain>` | `api.<domain>` |
| Deploy | Every push to `main` in the backend repository | A git tag `api-v*` |

- **Caddy** in its own container terminates TLS for both hostnames (automatic certificates) and reverse-proxies to the two API containers. Only ports 80/443 are open; SSH is closed and access is by SSM Session Manager.
- **Images**: GitHub Actions builds the Docker image and pushes to ECR; the deploy step runs over SSM `send-command`: pull the image, `prisma migrate deploy` using `DATABASE_MIGRATION_URL`, then restart the container. A failed migration aborts the restart.
- **Secrets** live in SSM Parameter Store (`/agrawal/<env>/<NAME>`, SecureString) and are written to the container's env at start by the deploy script. Nothing secret is committed; `.env.example` lists names only.
- **Backups**: RDS automated backups, 7-day retention, point-in-time recovery. S3 versioning on the media buckets.
- **Observability**: container logs to CloudWatch Logs via the `awslogs` driver; `/healthz` (process up) and `/readyz` (database + pg-boss reachable) polled by a CloudWatch Synthetics canary or an external uptime checker that alerts the Operator. Alert on: `/readyz` failing, any `payments.reconcile` run finding a captured payment the webhook missed, and any job exhausting its retries.

### Web hosting note

`Agrawal_Frontend/apps/web` is not built by this plan, but the API depends on two facts about it: it is served from `https://register.<domain>` (or another subdomain of the API's domain), and that origin is in `WEB_ORIGINS` for CORS/CSRF. Auth OTP is handled via backend Amazon SNS (`POST /v1/auth/otp`), eliminating Firebase authorized domain constraints for web (ADR-0034); local web development uses `SMS_PROVIDER=console`.

## Security checklist (M13, and reviewed at M5)

- [ ] Every route has a Zod schema for params, query and body, and an auth requirement explicitly declared (`public`, `principal`, `member`, `role(X)`). *(Open: `test/openapi.test.ts` confirms method/path coverage for 95 runtime operations, not that every handler installs runtime `validate()` or declares public access; the route audit still finds inline parsing and public routes without an explicit `public` declaration.)*
- [x] Every Member-facing response uses a Register projection; Member visibility rules are centralized in Register. *(Source audit found narrow non-response Member reads outside Register: reauthentication phone matching in `src/main.ts`, notification language in `src/adapters/governance.ts`, member-ID candidates in `src/adapters/member-lookup.ts`, and an existence check in `src/adapters/notices-db.ts`. Officer lookup projects candidate IDs through Register before returning them. Tests: `test/register-policy.test.ts` covers Invariants 16, 20, 22; `test/register-directory.test.ts` exercises directory responses. The former claim that there are no Member selects outside Register was false.)*
- [x] CSRF origin check on every cookie-authenticated unsafe method; tested. *(Verified: `src/http/csrf.ts` is mounted globally in `src/app.ts`; `test/foundation.test.ts` accepts an exact allowed Origin and rejects missing or near-match Origins with 403.)*
- [ ] Rate limits on session exchange, payment orders, join submissions, Family ID checks, romanization, uploads and reports. *(The prior `/v1/auth/session` gap claim was false: `IdentityService.createSession` applies persistent IP and phone limits via the store wired in `src/main.ts`; `test/identity-auth.test.ts` asserts both boundaries, and `test/rate-limit.test.ts` covers middleware boundary/key behavior. The named registration, romanization, upload and report paths have route limits. Still open: the Business Listing payment-order and renewal routes in `src/modules/notices/routes.ts` do not attach a rate limit, so the broad payment-orders criterion is not complete.)*
- [x] Verify webhook signatures over the raw body before parsing and deduplicate replayed event IDs. *(`src/app.ts` mounts the webhook before `express.json()`; `PaymentWebhookService.receive` verifies HMAC-SHA-256 over raw bytes before JSON parsing. `test/payment-locks.test.ts` proves invalid signatures are not persisted and a valid replay does not enqueue a second job. This source contract is verified even though user-facing payment activation and live Razorpay verification remain deferred until Play publication and credentials.)*
- [ ] Never trust client-supplied payment amount, status or identity. *(Source uses server-configured fees, verifies provider order/amount/status before applying state, and HMAC-hashes payment identity. `test/notices.test.ts` checks the configured ₹49 renewal amount, but there is no focused existing test covering client attempts to alter amount/status/identity across the payment lifecycle; keep this item open. Payment deferral is a separate activation decision.)*
- [ ] Uploads: size cap, magic-byte check, sharp re-encode and EXIF stripping. *(Implementation is present in `MediaService.prepareImage` (`src/modules/media/service.ts`), but `test/media.test.ts` and `test/image-ownership.test.ts` cover visibility, ownership, screening and cleanup—not size rejection, unsupported magic bytes, re-encoding or metadata removal. The previous claim that those security properties were tested in these files was unsupported.)*
- [ ] Processing Record grants and triggers verified by a test that attempts `UPDATE` as the app role and expects failure. *(`test/retention.test.ts` has four conditional app-role tests; all four were skipped in the parent-reported 153-pass/4-skip run because `TEST_APP_DATABASE_URL` was not supplied. Existing cases attempt restricted-table reads/deletes and `processing_record` delete, but not `UPDATE`. The RDS read-only audit confirmed `agrawal_app` and seven migrations only; it did not verify grants.)*
- [ ] Log redaction verified by a test that logs a registration request and asserts no phone, DOB or address in output. *(`src/logger.ts` redacts `req.body` and sensitive fields. `test/logging.test.ts` covers credentials, URL/device tokens and a standalone phone field; it does not log a registration request body or assert absence of phone, date of birth and address.)*
- [ ] Dependencies pinned; `npm audit --omit=dev` reviewed. *(`package.json` declares exact versions for dependencies and devDependencies. The operational `npm audit --omit=dev` review remains open and was not run in this audit.)*
- [x] Session cookie `HttpOnly; Secure; SameSite=Lax; Path=/`; tokens stored hashed. *(`src/http/auth.ts` sets these cookie attributes and `IdentityService` stores SHA-256 token hashes; `test/identity-auth.test.ts` verifies the emitted cookie attributes and that persisted token material differs from the bearer token.)*
- [x] Officer and Operator routes require the role on the server; the web hiding a button is not access control. *(`src/modules/officer/routes.ts` mounts `requireRole("OFFICER")` and `requireRole("OPERATOR")`; `test/officer.test.ts` asserts 403 for a Member on an Officer route and an Officer on an Operator route.)*
