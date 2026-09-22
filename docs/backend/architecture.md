# Architecture

The cross-cutting shape of the API (`Agrawal_Backend/`). Module-specific rules live in `modules/`; this file holds only what every module shares.

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 24 LTS | Matches the repo's local toolchain. |
| Language | TypeScript, `strict: true`, `noUncheckedIndexedAccess: true` | ESM (`"type": "module"`), like the repo root. |
| HTTP | Express 5 | Express 5 forwards rejected promises from async handlers to the error middleware; no wrapper needed. |
| Validation + contract | zod | Every request body, query and params object and every response body is a zod schema. OpenAPI 3.1 is generated from those schemas with `@asteasolutions/zod-to-openapi`. At install, confirm the generator's supported zod major and pin zod to it. |
| Database | PostgreSQL 16 on RDS (`db.t3.small`, single-AZ) | Extensions: `pg_trgm`, `citext`. |
| ORM | Prisma, **`prisma` and `@prisma/client` pinned to the same exact stable version** | ADR-0014 §13: an unpinned `prisma` resolves to a release candidate. Use Prisma's multi-file schema: one `.prisma` file per module under `prisma/schema/`. Follow Prisma's current Express guide for the driver-adapter setup of the pinned major. |
| Jobs | pg-boss | Queue lives in the same Postgres. Jobs are enqueued inside the domain transaction where the domain change happens. |
| Logging | pino + pino-http | JSON logs, request ID on every line, redaction list below. |
| Security headers | helmet | Default config; API serves JSON only. |
| Tests | vitest + supertest | Against a real Postgres. |
| Phone auth | `firebase-admin` (`auth().verifyIdToken`) | Client-side Firebase Phone Auth; server only verifies. |
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
| `NODE_ENV` | `production` | |
| `APP_ENV` | `local` \| `staging` \| `production` | Distinct from NODE_ENV; selects vendor projects. |
| `PORT` | `3000` | |
| `DATABASE_URL` | | App role (restricted grants, see Processing Record). |
| `DATABASE_MIGRATION_URL` | | Owner role, used only by `prisma migrate deploy`. |
| `WEB_ORIGINS` | `https://register.example.in` | Comma-separated exact origins for CORS and CSRF. |
| `SESSION_TTL_WEB_DAYS` | `30` | Sliding. |
| `SESSION_TTL_MOBILE_DAYS` | `90` | Sliding. |
| `FIREBASE_PROJECT_ID` | | |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | | From SSM. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | | Test keys on staging, live on production. |
| `RAZORPAY_WEBHOOK_SECRET` | | |
| `REGISTRATION_PAYMENT_PAISE` | `100` | ₹1 (ADR-0016). |
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

### Error envelope

```json
{ "error": { "code": "DUPLICATE_HEAD", "message": "…", "details": { } }, "requestId": "…" }
```

`AppError(code, httpStatus, details?)` is the only thrown error type in services. The error middleware maps: `AppError` → its status; zod failure → `400 VALIDATION_FAILED` with `details.issues` (path + message per field); Prisma unique violation not already mapped → `409 CONFLICT`; anything else → `500 INTERNAL` with no internals leaked, logged at `error` with the request ID.

Shared codes: `VALIDATION_FAILED` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `RATE_LIMITED` 429 (with `Retry-After`), `IDEMPOTENCY_KEY_REUSED` 422, `INTERNAL` 500, `UPSTREAM_UNAVAILABLE` 503. Module-specific codes are listed in each module file. Every code appears in `src/http/errors.ts` with its `{en, hi}` message.

### Idempotency

Every `POST` that creates a resource or moves money accepts an `Idempotency-Key` header (UUID). Mark those routes with `idempotent()` middleware. Table `IdempotencyRecord(principalKey, key, requestHash, responseStatus, responseBody, createdAt)`, unique `(principalKey, key)`, kept 24 hours. Same key + same body hash → replay the stored response. Same key + different body → `422 IDEMPOTENCY_KEY_REUSED`. The web and Flutter clients generate one key per user action and reuse it on retry.

### CORS and CSRF

- CORS: `cors({ origin: WEB_ORIGINS (exact match), credentials: true })`. The Flutter app is not a browser and needs no CORS.
- CSRF (cookie sessions only; `csurf` is archived, ADR-0014 §12): for any unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) authenticated by the `sid` cookie, require an `Origin` header exactly equal to one of `WEB_ORIGINS`; otherwise `403 FORBIDDEN`. Bearer-authenticated requests skip the check. JSON-only bodies force a CORS preflight for cross-origin writes, which is the second layer.
- **The web client and the API must be same-site** (subdomains of one registrable domain, e.g. `register.<domain>` and `api.<domain>`) or `SameSite=Lax` cookies will not be sent on `fetch`. The domain is an open Operator fact (`open-questions.md`); M0 cannot finish without it.

### Rate limiting

`src/http/rate-limit.ts` exports `rateLimit({ name, key: (req) => string, limit, windowSeconds })`. Storage is the table `RateLimitBucket(name, key, windowStart, count)` with an atomic `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`; a daily job deletes buckets older than two days. Limits survive restarts and are shared by every process. Exceeding a limit returns `429 RATE_LIMITED` with `Retry-After`. Default limits are listed in `modules/identity.md`; each module lists its own.

## Jobs

- One pg-boss instance, started in `main.ts`. At pilot scale the HTTP server and the workers run in **one process**; `WORKERS_ENABLED=false` lets a second process serve HTTP only if that is ever needed.
- Job names are `<module>.<verb>` (`registration.expireJoinRequest`). Each module registers its workers in its `jobs.ts` via `registerWorkers(boss, deps)`.
- Enqueue inside the domain transaction: pg-boss's `send` accepts a `db` option executing through the caller's connection; use it with the Prisma transaction's connection (`tx.$executeRaw` wrapper) so a rolled-back transaction enqueues nothing. If wiring that proves impractical for the pinned versions, use a transactional outbox table (`OutboxJob`) written in the transaction and drained into pg-boss by a 5-second poller — pick one and use it everywhere.
- Every worker is idempotent: it re-reads current state and exits quietly if the work is already done. Retries: `retryLimit: 5`, `retryBackoff: true`.
- Scheduled jobs (`boss.schedule`, cron in `Asia/Kolkata`):

| Job | Schedule | Module |
|---|---|---|
| `payments.reconcile` | every 10 min | payments |
| `registration.abandonIdle` | every 15 min | registration |
| `registration.expireJoinRequests` | hourly | registration |
| `register.purgeRestricted` | daily 03:00 | register |
| `identity.purgeSessionsAndBuckets` | daily 03:30 | identity |
| `http.purgeIdempotency` | daily 03:45 | (shared) |
| `noticeboards.expireListings` | hourly (Stage 2) | noticeboards |
| `noticeboards.endSuspensions` | every 15 min (Stage 2) | noticeboards |
| `noticeboards.escalateArchivals` | hourly (Stage 2) | noticeboards |

Timed per-entity work (a Blood SOS widening step, a join request's expiry) uses `send` with `startAfter`, not a cron scan, and the cron scan exists as a backstop.

## Time

All storage in UTC (`timestamptz`). "Today" and "a day" mean the **IST calendar day** (`Asia/Kolkata`): the adult check (age ≥ 18 on today's IST date), the daily posting cap. `clock.ts` exposes `now()` and `todayIst()`; nothing calls `new Date()` directly outside it, so tests can move time. The one exception is retention purging: the purge functions compare `retain_until` with the database's `now()`, so the app role cannot make rows expire early by passing a later time.

## The Processing Record

An append-only audit table owned by the Officer module (see `modules/officer.md` for the action list). Every Officer action, every Officer read of Member-only data, every Erasure, every refund and every consent change writes one row, **in the same transaction** as the action. It is what ADR-0013 §7 required in place of direct database access, and what DPDP requires as a processing log.

Append-only is enforced by the database, not by convention (raw SQL migration in `prisma/sql/`):
- The app role (`DATABASE_URL`) has `INSERT, SELECT` on `processing_record` and no `UPDATE`/`DELETE`.
- A trigger raises on `UPDATE`, and on `DELETE` of any row whose `retain_until` is in the future; the purge job deletes expired rows by calling the owner-owned `SECURITY DEFINER` function `public.purge_expired_processing_records()`, the only thing the app role may execute to delete.

## Logging

pino with a redaction list covering: `req.headers.authorization`, `req.headers.cookie`, `*.firebaseIdToken`, `*.phoneE164`, `*.vpa`, `*.dateOfBirth`, `*.address*`, `*.bloodGroup`, `*.nominee*`, and every request body on `/v1/registration*`, `/v1/me*` and `/v1/officer*`. Log the route, status, duration, request ID and principal ID — never Member data. Logs are operational and rotate; they are **not** the processing record.

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
| Firebase | Project `…-staging` | Project `…-prod`, India enabled in SMS region policy |
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

`Agrawal_Frontend/apps/web` is not built by this plan, but the API depends on two facts about it: it is served from `https://register.<domain>` (or another subdomain of the API's domain), and that origin is in `WEB_ORIGINS` and in the Firebase project's authorized domains. `localhost` is not an authorized phone-auth domain (ADR-0014 §8); local web development against real OTP uses the staging host.

## Security checklist (M13, and reviewed at M5)

- [ ] Every route has a zod schema for params, query and body, and an auth requirement declared explicitly (`public`, `principal`, `member`, `role(X)`).
- [ ] Every Member-facing response built through a Register projection; a grep for `select:` on `member` outside `modules/register` returns nothing.
- [ ] CSRF origin check on every cookie-authenticated unsafe method; tested.
- [ ] Rate limits on session exchange, payment orders, join submissions, Family ID checks, romanization, uploads, reports.
- [ ] Webhook signature verified over the raw body before any parsing; replayed event IDs ignored.
- [ ] No client-supplied amount, payment status or payment identity is ever trusted.
- [ ] Uploads: size cap, magic-byte check, sharp re-encode, EXIF stripped.
- [ ] Processing Record grants and triggers verified by a test that attempts `UPDATE` as the app role and expects failure.
- [ ] Log redaction verified by a test that logs a registration request and asserts no phone, DOB or address in output.
- [ ] Dependencies pinned; `npm audit --omit=dev` reviewed.
- [ ] Session cookie `HttpOnly; Secure; SameSite=Lax; Path=/`; tokens stored hashed.
- [ ] Officer and Operator routes require the role on the server; the web hiding a button is not access control.
