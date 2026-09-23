# Remaining backend work

The Stage 1 and Stage 2 backend, Flutter transport client, deployment assets, database schema, migrations, workers, and source-level security fixes are implemented. The remaining work requires infrastructure, operator decisions, and live vendor accounts. A reachable PostgreSQL instance (AWS RDS) now exists; see §1. Do not commit credentials to this repository.

**Repository layout, 21 September 2026:** the project split into three sibling repositories. This repository (`Agrawal_Backend/`) holds the API, backend tests, database schema, migrations, and deployment assets. The Flutter app and project-level docs live in `Agrawal_App/`; prototypes and web surfaces live in `Agrawal_Frontend/`.

## 1. PostgreSQL required to finish runtime verification

A reachable instance was previously verified: AWS RDS PostgreSQL 18.3 at `database-1.cvm24i0yc44i.ap-south-1.rds.amazonaws.com:5432` (ap-south-1, publicly accessible, SSL enforced by pg_hba). On 21 September 2026, TLS `verify-full` with the RDS global CA bundle connected, and `pg_trgm`, `citext`, and `unaccent` were available but not installed. A local `.env` exists again (23 September 2026). It must use separated migration/runtime roles, not the master `postgres` role.

Connection-string constraint: the repo's `pg` v8 maps `sslmode=require` to full certificate verification, so URLs must use `sslmode=verify-full&sslrootcert=<absolute path to global-bundle.pem>`.

Engine version: PostgreSQL 18 is the project version (ADR-0029, 23 September 2026), matching this 18.3 instance; CI and local compose use `postgres:18-alpine`. Prisma 7.10 and both migrations are not yet verified on 18.3; the checks below do that.

Remaining checks:

1. Provision the real roles: create the `agrawal_dev` database, install `pg_trgm`/`citext`/`unaccent`, create the least-privilege `agrawal_app` role with restricted-schema grants, then repoint `DATABASE_URL` (app role) and `DATABASE_MIGRATION_URL` (migration-owner role) away from the master credentials.
2. Apply `Agrawal_Backend/prisma/migrations/20260919000000_foundation/migration.sql` to an empty database.
3. Run `npm run test` in `Agrawal_Backend/` against the isolated test database.
4. Verify the application role can use normal public tables and insert required restricted retention rows.
5. Verify the application role cannot select restricted payment data or update/delete `processing_record`.
6. Exercise every raw SQL trigger, partial unique index, immutable field, succession transaction, webhook replay, and erasure-retention path.
7. Confirm all 13 recurring pg-boss schedules exist once and execute successfully.

Local fallback status (22 September 2026): the project PostgreSQL Docker container and `postgres:16-alpine` image were removed because this workstation must not write Docker layers to the root filesystem. No host PostgreSQL server/client is installed. Further local database verification requires a root-safe PostgreSQL runtime with binaries/cache on the WD workspace and data in RAM, or the separated non-production RDS database.

## 2. Operator facts required before staging

Resolved operator decisions are recorded in ADR-0026, ADR-0027, ADR-0028 and ADR-0029.

The authoritative open-questions ledger is [`backend/open-questions.md`](backend/open-questions.md).

Still owed before staging:

- The Google Cloud project for romanization (M2).
- A decision on re-signing `feature-list.md`, which now diverges from ADR-0022, ADR-0025 and ADR-0026.

Implementation items created by ADR-0026:

- Sweep legacy "Agarwal Samaj" strings to "Agrawal Samaj" across the prototypes, Flutter strings, spec documents and store copy (ADR-0026 §4 supersedes the Stage 1 brief's spelling mandate).
- Accept `urgency` / `patientRelation` / `hospitalArea` in `BloodSosCreateBody` (ADR-0026 §7).
- Event Pass re-claim: reactivate a `MEMBER_CANCELLED` row with a fresh signature (ADR-0026 §10).
- Enforce the 30-live-images per-owner quota in media (ADR-0026 §11).

## 3. External services and credentials

Create separate staging and production values. Store production/staging secrets as encrypted AWS SSM `SecureString` parameters under `/agrawal/<staging|production>/`; never place them in `.env.example`, source control, build logs, or Flutter assets.

### Firebase Phone Authentication and FCM

Required:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

Provider work:

- Create or select the Firebase projects.
- Enable Phone Authentication and configure the India SMS region policy.
- Add the final web domains to Firebase authorized domains.
- Enable/configure FCM for Android and iOS.
- Restrict service-account IAM to the required authentication and messaging operations.
- Verify a real OTP exchange and a real-device push, including invalid-token deletion.

### Razorpay

Required:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`

Provider work:

- Supply test credentials for staging and live credentials for production.
- Register the raw webhook endpoint and enable required payment/refund events.
- Confirm UPI Intent/QR support on the account.
- Run ₹1 registration and ₹49 Business Listing transactions on staging.
- Replay captured and failed webhook events and confirm idempotency.
- In production, record whether Razorpay supplies an unmasked `vpa` for the first real ₹1 payment; update `backend/open-questions.md` with the result.

### AWS

Production runs at `https://backend.agrawal.app` on EC2. `.github/workflows/deploy.yml` deploys it on a push to `prod` (self-hosted runner, PM2, nginx, environment from Secrets Manager `prod/agrawal/env`). The items below are still required, mainly for staging.

Required infrastructure:

- RDS PostgreSQL 18 databases for staging and production (ADR-0029). One PostgreSQL 18.3 instance in ap-south-1 is reachable with enforced TLS, and local credentials exist again (see §1). Assign it to an environment or create per-environment databases and restrict network access before it holds real data.
- Private S3 media buckets with Block Public Access, encryption, lifecycle policy, and least-privilege API access.
- ECR repositories for staging and production images.
- EC2 host with Docker/Caddy and SSM Agent.
- SSM Parameter Store hierarchy and KMS key/policy.
- DNS records and TLS for `staging-api.<domain>`.
- RDS automated backups/PITR and a restore target.

GitHub repository configuration required by this repository's API workflow (`.github/workflows/api.yml`):

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `STAGING_EC2_INSTANCE_ID`
- `PROD_EC2_INSTANCE_ID`
- `ECR_REPOSITORY_STAGING` (optional only if the documented default exists)
- `ECR_REPOSITORY_PROD` (optional only if the documented default exists)
- `AWS_REGION` repository variable, normally `ap-south-1`

Prefer GitHub OIDC and a least-privilege deploy role over long-lived AWS access keys before production.

### Google Cloud Translation

Required:

- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`

Provider work:

- Enable Cloud Translation API and billing.
- Create a least-privilege service account.
- Verify Devanagari-to-Latin romanization with representative names.

### Sightengine image screening

Required only when automated screening is enabled:

- `SIGHTENGINE_API_USER`
- `SIGHTENGINE_API_SECRET`
- `IMAGE_SCREENING_ENABLED=true`

Keep screening disabled until credentials, billing limits, timeout behavior, Officer override, and backlog processing are verified on staging. With screening disabled, unscreened photos remain uploader-only.

### Application-generated secrets

Generate independent staging and production values:

- `PAYMENT_IDENTITY_HMAC_KEY`: at least 32 random bytes, base64 encoded.
- `EVENT_PASS_SIGNING_KEYS`: JSON key ring containing Ed25519 key IDs and private PEM keys; first key signs and all listed keys verify.

Store event private keys in SSM/KMS, define rotation and revocation procedures, and retain old public verification keys for passes that remain valid.

## 4. Full environment configuration

Populate every required field from `Agrawal_Backend/.env.example` in SSM, including:

- Runtime: `NODE_ENV`, `APP_ENV`, `PORT`, `WEB_ORIGINS`, worker enablement.
- Database URLs.
- Firebase, Razorpay, HMAC, S3, Google, Sightengine, and Event Pass values.
- Registration, retention, Noticeboard, Blood SOS, media, and session tuning values.
- `ERASURE_SELF_SERVICE_ENABLED` only after recent-authentication behavior is verified.

Production must not use the placeholder `https://register.example.in` origin.

## 5. Staging acceptance

After infrastructure and secrets exist:

1. Push/apply the migration and verify `/healthz` and `/readyz`.
2. Run the complete API test suite against staging-equivalent PostgreSQL.
3. Verify real Firebase OTP sign-in and session revocation.
4. Complete founding and joining flows with Razorpay test payments, Head confirmation, webhook replay, refund paths, Family minting, and role changes.
5. Verify private media upload/access, screening behavior, Officer removal, and object cleanup.
6. Verify directory projections, nominee access logging, succession, archival, and erasure into `restricted` storage.
7. Verify FCM delivery and invalid-token cleanup on real devices.
8. Verify Noticeboards, reports, suspensions, Business Listing payment/expiry, and archival escalation.
9. Verify Blood SOS exact-city matching, widening, accepted-alert reach, response authorization, and generic request-ID-only push payloads.
10. Verify Event Pass signing, offline validation, revoked manifests, device isolation, and scan replay.
11. Confirm every recurring pg-boss schedule has a recent successful run.
12. Execute the runtime-role privilege checks in `Agrawal_Backend/deploy/README.md`.

## 6. Production cutover and operations

Before creating an `api-v*` production tag:

- Require GitHub production-environment approval and protected tags.
- Verify ECR image immutability/scanning/signing and least-privilege SSM deployment access.
- Verify RDS encryption, TLS, network security groups, automated backups, PITR, monitoring, and audit logging.
- Rehearse restoration of the staging database from an RDS snapshot and record recovery time/evidence.
- Verify S3 encryption, Block Public Access, lifecycle cleanup, and object access logs.
- Run a real ₹1 founding payment, inspect VPA availability, erase the test Member, and issue the refund.
- Confirm no API container uses `DATABASE_MIGRATION_URL` or other owner credentials at runtime.
- Repeat the security review against the deployed environment and live IAM/network policies.

## Completion boundary

Repository implementation can continue without external credentials only for source changes. Database integration tests, live OTP/payment/push/storage/translation/screening behavior, staging deployment, production cutover, backup restore rehearsal, and cloud-control verification require the inputs above. Those are the remaining backend deliverables.