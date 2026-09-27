# Agrawal Samaj — Backend API (`Agrawal_Backend`)

The core REST API and background worker service powering the Agrawal Samaj platform. Built with Express 5, TypeScript, Prisma ORM, and PostgreSQL.

This service owns the single HTTP contract that all client applications (`Agrawal_App` Flutter mobile app and `Agrawal_Frontend` web client) build against. All web and API workloads deploy to AWS infrastructure under the Operator's control (Vercel is retired per ADR-0028).

---

## Features & Modules

| Module | Purpose |
|---|---|
| **`identity`** | Member households, Family links, head-of-family anchor, invitations, and Gotra management. |
| **`registration`** | Self-registration flow, phone verification via Firebase, duplicate detection, and friction fee handling. |
| **`blood-sos`** | Emergency blood donor matching ladder (place-based radial matching), request alerts, and privacy-shielded reach reporting. |
| **`events`** | Community event registration, pass minting, Gate Device verification, and offline admission sync. |
| **`notices`** | Shok Sandesh (obituaries) with respect periods and general community announcements. |
| **`business`** | Verified community business directory, categorisation, and keyword search. |
| **`officer`** | Grievance escalation, duplicate review, and statutory data erasure with restricted archival (DPDP Act compliance). |
| **`payments`** | Razorpay payment intent creation, signature verification, and idempotency-guarded webhooks. |
| **`media`** | Presigned S3 uploads and automated visual content safety moderation via Sightengine. |
| **`notifications`** | Push delivery via Firebase Cloud Messaging (FCM) with background retry queue. |

---

## Technology Stack

- **Runtime**: Node.js `>=24.0.0`
- **Framework**: Express 5 (TypeScript, ESM)
- **Database & ORM**: PostgreSQL 18 (matches the AWS RDS 18.3 instance, ADR-0029) + Prisma 7 (pg adapter)
- **Background Jobs**: `pg-boss` queue runner
- **API Spec & Validation**: Zod v4 schemas + `@asteasolutions/zod-to-openapi` (OpenAPI v3.1)
- **Authentication**: Firebase Phone Auth exchange → Secure HTTP-only session cookies / Bearer tokens
- **Testing**: Vitest + Supertest

---

## Directory Layout

```
src/
  adapters/               Third-party adapters (S3, Razorpay, Sightengine, Translate, Pincode)
  http/                   Middleware (auth, CSRF, rate-limiting, error handling, idempotency)
  modules/                Domain feature modules (routes, schemas, services, background jobs)
  openapi/                OpenAPI spec registry and code generator
  app.ts                  Express application setup and route registration
  config.ts               Validated environment configuration
  db.ts                   Prisma client database connection
  main.ts                 HTTP server and worker entry point
prisma/
  schema/                 Prisma schema split by domain models
deploy/                   Deployment manifests and systemd unit files
docs/                     Architecture guides, module specs, and remaining work tracker
openapi/                  Exported OpenAPI v1 specifications (v1.yaml and openapi.json)
test/                     Integration test suite (Vitest)
```

---

## Getting Started

### Prerequisites
- **Node.js**: `>=24.0.0`
- **npm**: `>=10.0.0`
- **PostgreSQL**: PostgreSQL 18 (local Docker or AWS RDS instance)

### Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   ```
   > **Note**: Edit `.env` with your local database URL and provider credentials. Never commit `.env` or paste live RDS credentials into version control.

3. **Generate Prisma client & run migrations**:
   ```bash
   npm run prisma:generate
   npm run prisma:migrate
   ```

4. **Start the development server**:
   ```bash
   npm run dev
   ```
   The API will listen at `http://localhost:3000`.

---

## Scripts & Testing

```bash
# Typecheck TypeScript source
npm run typecheck

# Build production bundle to dist/
npm run build

# Run linter
npm run lint

# Vitest needs TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL (or corresponding
# DATABASE_* URLs) naming a test database; the migration role needs CREATEDB.
# Each test file creates and drops its own temporary database. TEST_APP_DATABASE_URL,
# when set, is redirected to that same temporary database for app-role checks.
# URLs exported in the shell win over .env, and the setup refuses any host other
# than localhost/127.0.0.1/::1/postgres unless ALLOW_REMOTE_TEST_DB=1.
npm test

# Generate OpenAPI contract (openapi/v1.yaml & openapi.json)
npm run openapi

# Start production server
npm start
```

---

## Docker Deployment

Build and run using the standalone Docker container:

```bash
# Build Docker image
docker build -t agrawal-api .

# Run with docker-compose (spins up local postgres and api)
docker compose up -d
```

---

## Documentation & References
 
 - Domain rules & glossary: [`CONTEXT.md`](CONTEXT.md)
 - Remaining backend work & live RDS checklist: [`docs/REMAINING BACKEND WORK.md`](docs/REMAINING%20BACKEND%20WORK.md)
 - Backend architecture documentation: [`docs/backend/architecture.md`](docs/backend/architecture.md)
 - Play Store compliance binder & Data Safety disclosures: [`../Agrawal_App/docs/compliance/play-store-compliance.md`](../Agrawal_App/docs/compliance/play-store-compliance.md)
 - Architecture Decision Records: [`../Agrawal_App/docs/adr/`](../Agrawal_App/docs/adr/) (including ADR-0027 mailbox handover and ADR-0028 AWS deployment)

---

## Governance & DPDP Compliance

- **Data Fiduciary:** Mr. Rahul Kumar Agrawal, proprietor personally (ADR-0026 §1).
- **Data & Verification Officer:** Mr. Rahul, responsible for identity integrity and moderation (ADR-0005, ADR-0017).
- **Grievance Redressal Mailbox:** `help.agrawal.app@gmail.com` (ADR-0027), protected under 2FA and recovery phone, monitored to statutory 30-day resolution SLA. Supersedes the never-existed `grievance@agrawalsamaj.org`.
