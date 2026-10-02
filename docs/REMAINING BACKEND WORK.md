# Remaining backend work

The core Stage 1/2 backend and Flutter transport, deployment assets, database schema, migrations and workers are in place, but this ledger does not claim full source completion: three backend ADR-0026 implementation tasks remain open in §2, along with security verification gaps. These source statuses do not reopen the normative ADR decisions. Security evidence is audited in `docs/backend/architecture.md` and its `Agrawal_App` mirror. The AWS RDS `agrawal_dev` database is reachable; see §1. Do not commit credentials to this repository.

**Repository layout, 21 September 2026:** the project split into three sibling repositories. This repository (`Agrawal_Backend/`) holds the API, backend tests, database schema, migrations, and deployment assets. The Flutter app and project-level docs live in `Agrawal_App/`; prototypes and web surfaces live in `Agrawal_Frontend/`.

## 1. PostgreSQL required to finish runtime verification

A reachable instance was previously verified: AWS RDS PostgreSQL 18.3 at `database-1.cvm24i0yc44i.ap-south-1.rds.amazonaws.com:5432` (ap-south-1, publicly accessible, SSL enforced by pg_hba). On 21 September 2026, TLS `verify-full` with the RDS global CA bundle connected, and `pg_trgm`, `citext`, and `unaccent` were available but not installed. A local `.env` exists again (23 September 2026). It must use separated migration/runtime roles, not the master `postgres` role.

Connection-string constraint: the repo's `pg` v8 maps `sslmode=require` to full certificate verification, so URLs must use `sslmode=verify-full&sslrootcert=<absolute path to global-bundle.pem>`.

Engine version: PostgreSQL 18 is the project version (ADR-0029, 23 September 2026), matching this 18.3 instance; CI and local compose use `postgres:18-alpine`. On 27 September 2026, Prisma 7.10 and all 7 migrations applied to a local PostgreSQL 18.6 (`postgres:18-alpine`). On the RDS `agrawal_dev` database, a read-only audit confirmed role `agrawal_app` and all 7 migrations applied through `20260926000000_payment_refund_attempts` (this includes `20260925000050_blood_sos_tier_zero`). However, read-only inspection does NOT establish restricted privilege guarantees (e.g., application-role least-privilege schema boundaries, denial of restricted-table access, or processing_record update/delete prevention). The checks below are still open.

Remaining checks:

1. **OPEN — provisioning partly observed.** The later read-only audit found `agrawal_dev`, `agrawal_app` and all 7 migrations; do not recreate the database or role based on the earlier checklist. Still verify extensions are installed in the intended environment, actual least-privilege grants/network restrictions, and that `DATABASE_URL` and `DATABASE_MIGRATION_URL` use separate runtime/owner roles.
2. **OPEN — role behavior unverified.** All four conditional app-role tests in `test/retention.test.ts` were skipped in the parent-reported run. They exercise retention purge and pg-boss paths, but none directly attempts required restricted retention-row `INSERT` as `agrawal_app`; normal public-table use and allowed writes still need runtime confirmation.
3. **OPEN — privilege guarantees unverified.** The conditional tests attempt direct `SELECT`/`DELETE` on restricted tables and `DELETE` on `processing_record`, but no `UPDATE` attempt; all four were skipped. The RDS read-only evidence establishes only the role and migration status.
4. **OPEN — not exhaustively proved.** The PostgreSQL 15 suite passed its existing tests, but no evidence here demonstrates that every raw SQL trigger, partial unique index, immutable field, succession transaction, webhook replay and erasure-retention path was exercised against the intended PostgreSQL 18 RDS runtime role.
5. **OPEN — runtime schedule check.** Source and `main.ts` register 14 recurring handlers, including `bloodSos.processPending`; the current `test/jobs.test.ts` schedule fixture covers only 13 and omits that Blood SOS cron. Verify all 14 are installed once and have recent successful pg-boss runs in the intended environment.

Verification status (2026-10-02): the response-contract correction passed typecheck, build, lint and OpenAPI generation, followed by **155 tests passed, 4 skipped; 30 test files passed and 1 skipped**, against isolated PostgreSQL 15 on Node 22.23.3. The new HTTP submission regressions retain the founder's Member ID (`201`) and omit it for a pending join (`202`). The compiled API passed wrong fixed code `401`, Member/Applicant login `201`, persisted bearer restoration/projection `200`, logout `204`, and revoked bearer `401`. The vendored Flutter YAML matches the backend YAML byte-for-byte. The four skipped application-role tests require `TEST_APP_DATABASE_URL`; PostgreSQL 18 and production Node 24 remain separate verification targets. No Firebase SMS, native-device or live-payment proof is claimed. Earlier `6429927` evidence was 153 passed / 4 skipped; historical PostgreSQL 18.6 evidence at `9aa8e06` was 145 passed / 4 skipped. Each suite creates and drops its own `test_<pid>_<uuid>` database, requiring `CREATEDB`. `test/test-database-guard.ts` rejects remote hosts by default; its explicit override is not approval to run destructive tests against RDS.

## 2. Operator facts and ADR follow-through

Resolved operator decisions are recorded in ADR-0026, ADR-0027, ADR-0028 and ADR-0029.

The authoritative open-questions ledger is [`backend/open-questions.md`](backend/open-questions.md).

Still owed before staging:

- **OPEN:** The Google Cloud project for romanization (M2).
- **OPEN:** A decision on re-signing `feature-list.md`, which currently diverges from ADR-0022, ADR-0025 and ADR-0026.

### ADR-0026 / ADR-0030 follow-through (audited against source and docs)

- **SOURCE COPIES CORRECTED — spelling:** the active frontend profile labels and registration-spec brand guidance now use “Agrawal”; historical quotations remain permitted by ADR-0030. Published store/grievance/privacy copy is a separate verification/reissue task and is not marked complete by a source edit.
- **OPEN — Blood SOS fields:** `BloodSosCreateBody` is strict and lacks `urgency`, `patientRelation` and `hospitalArea`; `prisma/schema/blood-sos.prisma` and the request/response schemas also lack them. Add persistence and API behavior required by ADR-0026 §7; current `test/blood-sos.test.ts` does not cover these fields.
- **OPEN — Event Pass re-claim:** `EventsService.claimPass` returns `PASS_ALREADY_EXISTS` for any existing pass; it has no `MEMBER_CANCELLED` reactivation/re-sign branch. `test/events.test.ts` has no re-claim case.
- **OPEN — media quota:** `MediaService.upload` has no count-based 30-live-image check and no `MEDIA_QUOTA_EXCEEDED` path; the media schema and tests have no quota invariant.

## 3. External services and credentials

Create separate staging and production values. Store production/staging secrets as encrypted AWS SSM `SecureString` parameters under `/agrawal/<staging|production>/`; never place them in `.env.example`, source control, build logs, or Flutter assets.

**Status for the provider/account work below: open or unverified.** Required secret names and setup steps are not proof that credentials are absent or present; this audit did not inspect provider consoles, secret stores, cloud resources or real devices.

### Firebase Phone Authentication and FCM

Required:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

**Status: partly evidenced; provider/account and push work remain open.** The parent reports a successful real-auth smoke (see §1). The recorded handoff does not identify the Firebase project, region-policy or authorized-domain evidence, and does not report real-device FCM delivery or invalid-token deletion.

Provider work:

- Create or select the Firebase projects.
- Enable Phone Authentication and configure the India SMS region policy.
- Add the final web domains to Firebase authorized domains.
- Enable/configure FCM for Android and iOS.
- Restrict service-account IAM to the required authentication and messaging operations.
- Capture the provider/configuration evidence for the reported real-auth smoke if not already recorded; verify real-device FCM delivery and invalid-token deletion.

### Razorpay

**Status (deferred):** Payments are unavailable until Google Play publication and MUST remain disabled in user-facing surfaces. Backend order creation, raw-body webhook HMAC verification and event-ID idempotency are implemented; `test/payment-locks.test.ts` verifies invalid raw signatures are not persisted and a valid duplicate event does not enqueue a second job. This source contract is distinct from live Razorpay registration, credentials and transaction verification, which are deferred until post-publication. Payment deferral neither invalidates nor waives the tested HMAC contract.

Required (when activated post-publication):

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`

Provider work (deferred until post-publication credentials):

- Supply test credentials for staging and live credentials for production.
- Register the raw webhook endpoint and enable required payment/refund events.
- Confirm UPI Intent/QR support on the account.
- Run ₹1 registration and ₹49 Business Listing transactions on staging.
- Live provider replay of captured/failed events remains deferred until credentials exist; source-level signature rejection and duplicate-event deduplication are already covered in `test/payment-locks.test.ts`.
- In production, record whether Razorpay supplies an unmasked `vpa` for the first real ₹1 payment; update `backend/open-questions.md` with the result.
### AWS

**Deployment evidence:** `https://backend.agrawal.app/readyz` was observed healthy before this change, and the latest inspected GitHub `prod` deployment run succeeded. The new fixed-OTP commit has **not** been deployed: the inspected production endpoint still required `firebaseIdToken`. `.github/workflows/deploy.yml` supports a manual ref deployment on a self-hosted `prod` runner using the server's Secrets Manager identity, PM2 and nginx; GitHub WRITE access was verified without using local AWS credentials. Staging deployment is separate in `.github/workflows/api.yml`.

Required infrastructure:

- PostgreSQL 18 databases for staging and production (ADR-0029). The parent read-only audit confirmed only the reachable RDS `agrawal_dev` database, role `agrawal_app` and seven migrations; it did not establish environment assignment, separate staging/production databases, network restrictions, grants or backups.
- Private S3 media buckets with Block Public Access, encryption, lifecycle policy, and least-privilege API access.
- ECR repositories for staging and production images.
- EC2/SSM plus the process/container and reverse-proxy stack selected by the still-open hosting decision (the runbook/Terraform describe Docker/Caddy; the production workflow uses PM2/nginx).
- SSM Parameter Store hierarchy and KMS key/policy.
- DNS records and TLS for `staging-api.<domain>`.
- RDS automated backups/PITR and a restore target.

Terraform definitions for the VPC, RDS, S3, ECR, EC2, KMS/SSM, DNS and CloudFront resources are in `Agrawal_Backend/deploy/terraform/` on `main` (2961598, PR #55, merged 27 September 2026). The stack uses OpenTofu; the recorded `tofu validate`/`tofu fmt -check` results are historical, not evidence of applied infrastructure. The stack is documented as not applied; `tofu plan` needs AWS credentials. Open items:

- **OPEN:** Run `tofu plan` for each environment, with one state for each environment (`deploy/terraform/versions.tf`); no plan is recorded.
- **OPEN:** Before the first apply to an existing stack, move each ECR repository and the apex, `www` and `register` records into the correct environment's state (cb6a9e5, 539d11c).
- **OPEN:** Decide the hosting model. `deploy/README.md` describes one shared EC2 host/RDS instance with `agrawal_staging` and `agrawal_prod`; Terraform builds a full stack per environment; the production workflow uses PM2/nginx rather than Docker/Caddy.
- **OPEN:** Link `deploy/rds-bootstrap.sql` and `deploy/restore-rehearsal.md` from `deploy/README.md`; the documents exist but the runbook does not link them.

GitHub repository configuration required by this repository's API workflow (`.github/workflows/api.yml`):

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `STAGING_EC2_INSTANCE_ID`
- `PROD_EC2_INSTANCE_ID`
- `ECR_REPOSITORY_STAGING` (optional only if the documented default exists)
- `ECR_REPOSITORY_PROD` (optional only if the documented default exists)
- `AWS_REGION` repository variable, normally `ap-south-1`

Prefer GitHub OIDC and a least-privilege deploy role over long-lived AWS access keys before production.

The historical ECR login failure was corrected to `aws-actions/amazon-ecr-login@v2` in `9c6a1f9`. No fresh staging success is claimed. The accessible self-hosted production workflow may deploy the verified ref without local AWS keys; activation and endpoint verification remain open for this change.
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

**Status: open/unverified.** The environment list below is a required configuration checklist, not evidence that SSM values are present or correct; no AWS secret-store values were inspected.

Populate every required field from `Agrawal_Backend/.env.example` in SSM, including:

- Runtime: `NODE_ENV`, `APP_ENV`, `PORT`, `WEB_ORIGINS`, worker enablement.
- Database URLs.
- Firebase, Razorpay, HMAC, S3, Google, Sightengine, and Event Pass values.
- Registration, retention, Noticeboard, Blood SOS, media, and session tuning values.
- `ERASURE_SELF_SERVICE_ENABLED` only after recent-authentication behavior is verified.

Production must set the actual frontend origin explicitly in `WEB_ORIGINS`; a missing or blank SSM parameter aborts deployment before migrations, and application config rejects missing or empty origin lists at startup.

## 5. Staging acceptance

After infrastructure and secrets exist:

**Status: all twelve staging acceptance checks below remain open.** The isolated PostgreSQL 15 suite and compiled MOBILE fixed-OTP/session smoke in §1 do not establish staging acceptance or Firebase/FCM/device behavior. Payment activation and live transactions are deferred until Google Play publication and configuration; the independently tested webhook HMAC source contract remains verified.

1. Push/apply the migration and verify `/healthz` and `/readyz`.
2. Run the complete API test suite against staging-equivalent PostgreSQL.
3. Verify fixed-code MOBILE login, restoration and revocation in the intended environment, and independently verify Firebase WEB authentication. Fixed OTP sends no SMS and does not establish phone ownership.
4. Complete founding and joining flows with Razorpay test payments, Head confirmation, webhook replay, refund paths, Family minting, and role changes (payment flow verification deferred until post-publication credentials).
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

**Status: all production cutover checks below remain open/unverified.** No AWS, production deployment or cutover check was run in this audit. The real-payment item is explicitly deferred until Play publication and actual credentials.

- Require GitHub production-environment approval and protected tags.
- Verify ECR image immutability/scanning/signing and least-privilege SSM deployment access.
- Verify RDS encryption, TLS, network security groups, automated backups, PITR, monitoring, and audit logging.
- Rehearse restoration of the staging database from an RDS snapshot and record recovery time/evidence.
- Verify S3 encryption, Block Public Access, lifecycle cleanup, and object access logs.
- Run a real ₹1 founding payment, inspect VPA availability, erase the test Member, and issue the refund (deferred until post-publication credentials).
- Confirm no API container uses `DATABASE_MIGRATION_URL` or other owner credentials at runtime.
- Repeat the security review against the deployed environment and live IAM/network policies.

## Completion boundary

Remaining deliverables include the open source items in §2 plus external credentials, integration verification against the intended database roles, staging acceptance, production cutover, backup restore rehearsal and cloud-control verification. These require the inputs and evidence listed above.