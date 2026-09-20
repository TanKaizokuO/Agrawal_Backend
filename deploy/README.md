# Deployment and Operations Runbook

This directory contains the deployment and operational infrastructure assets for `Agrawal_Backend` (formerly `apps/api`) per [`docs/backend/architecture.md`](../docs/backend/architecture.md).

---

## 1. Architecture Overview

- **Host**: Shared EC2 `t3.small` instance (`ap-south-1`).
- **Database**: PostgreSQL on AWS RDS (`db.t3.small`; target PG 16, current instance 18.3), separate databases `agrawal_staging` and `agrawal_prod`.
- **Reverse Proxy / TLS**: Caddy container terminating TLS via Let's Encrypt / ZeroSSL for both hostnames (`staging-api.<domain>` and `api.<domain>`).
- **Web Frontend**: Web surfaces (`Agrawal_Frontend`) also deploy to AWS (S3+CloudFront or EC2+Caddy); Vercel is retired (Agrawal_App ADR-0028).
- **Access**: SSH is closed. Access and deployments are performed exclusively via AWS Systems Manager (SSM) Session Manager and Run Command.
- **CI/CD**: GitHub Actions builds Docker images, pushes to Amazon ECR, and executes `deploy.sh` via `aws ssm send-command`.

| Environment | Hostname | Upstream Loopback Port | Docker Compose Stack | Database | Deploy Trigger |
|---|---|---|---|---|---|
| **Staging** | `staging-api.<domain>` | `127.0.0.1:3001` | `docker-compose.staging.yml` | `agrawal_staging` | Push to `main` in `Agrawal_Backend` |
| **Production** | `api.<domain>` | `127.0.0.1:3000` | `docker-compose.production.yml` | `agrawal_prod` | Git tag `api-v*` |

---

## 2. Secrets & Configuration (AWS SSM Parameter Store)

All secrets and environment variables are stored in AWS Systems Manager (SSM) Parameter Store under the prefix:

```
/agrawal/<staging|production>/<VARIABLE_NAME>
```

Sensitive values are stored as `SecureString` encrypted with KMS.

### Required SSM Parameters:

- `/agrawal/<env>/DATABASE_URL` (App role credentials)
- `/agrawal/<env>/DATABASE_MIGRATION_URL` (Owner role credentials for `prisma migrate deploy`)
- `/agrawal/<env>/WEB_ORIGINS` (Allowed origins for CORS and CSRF)
- `/agrawal/<env>/FIREBASE_PROJECT_ID`
- `/agrawal/<env>/FIREBASE_SERVICE_ACCOUNT_JSON`
- `/agrawal/<env>/RAZORPAY_KEY_ID`
- `/agrawal/<env>/RAZORPAY_KEY_SECRET`
- `/agrawal/<env>/RAZORPAY_WEBHOOK_SECRET`
- `/agrawal/<env>/PAYMENT_IDENTITY_HMAC_KEY`
- `/agrawal/<env>/S3_BUCKET`
- `/agrawal/<env>/GOOGLE_CLOUD_PROJECT`
- `/agrawal/<env>/GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `/agrawal/<env>/EVENT_PASS_SIGNING_KEYS` (Stage 2)
- `/agrawal/<env>/SIGHTENGINE_API_USER` (Stage 2)
- `/agrawal/<env>/SIGHTENGINE_API_SECRET` (Stage 2)

---

## 3. Deployment Flow (`deploy.sh`)

When triggered via SSM, `deploy.sh <env> <IMAGE_URI>` executes:

1. **Parameter Assembly**: Reads `/agrawal/<env>/*` from SSM and generates `.env.<env>` with restricted `0600` file permissions.
2. **Image Pull**: Pulls the new Docker image from Amazon ECR.
3. **Database Migration**: Runs `npx prisma migrate deploy` in an isolated ephemeral container using `DATABASE_MIGRATION_URL`. **If migration fails, the deployment exits immediately and existing containers remain untouched.**
4. **Service Restart**: Recreates and restarts the service container using `docker compose -f docker-compose.<env>.yml up -d --force-recreate`.
5. **Readiness Probe**: Polls `http://127.0.0.1:<port>/readyz` until HTTP 200 OK is observed (up to 60s). Fails the SSM command if the endpoint does not become ready.

---

## 4. Local Development

Local development uses `docker-compose.yml` in `Agrawal_Backend`, which starts **only** PostgreSQL 16:

```bash
# Start local PostgreSQL 16 (includes pg_trgm and citext extensions)
docker compose up -d

# Check readiness
docker compose ps
```

The database container automatically initializes:
- Required extensions: `pg_trgm`, `citext`.
- Dedicated roles: `postgres` (migration owner) and `agrawal_app` (restricted app user).

Connection strings for local development are provided in `.env.example`.

---

## 5. Database Role Verification

`DATABASE_MIGRATION_URL` is used only by the ephemeral migration container and
must belong to the database owner (or a role granted the migration privileges).
The long-running API container uses `DATABASE_URL` as the runtime application
role, normally `agrawal_app`; the owner connection must never be copied into the
API `.env` file.

The foundation migration and `postgres-init.sh` provision the runtime role with:

- `USAGE` on `restricted`;
- `INSERT` only on `restricted.member_tombstone`, `restricted.payment`,
  `restricted.refund`, and `restricted.consent_event`;
- `SELECT, INSERT` on `processing_record`, with `UPDATE, DELETE` revoked;
- the required `public` table and sequence privileges for Prisma and pg-boss;
- matching default privileges for tables and sequences created later by the
  migration owner.

After each deploy, run the following checks through the same `DATABASE_URL`
secret used by the API (not through `DATABASE_MIGRATION_URL`):

```bash
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c \
  "SELECT current_user, has_schema_privilege(current_user, 'restricted', 'USAGE');"

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c \
  "SELECT
     has_table_privilege(current_user, 'restricted.member_tombstone', 'INSERT') AS tombstone_insert,
     has_table_privilege(current_user, 'restricted.payment', 'INSERT') AS payment_insert,
     has_table_privilege(current_user, 'restricted.refund', 'INSERT') AS refund_insert,
     has_table_privilege(current_user, 'restricted.consent_event', 'INSERT') AS consent_insert,
     has_table_privilege(current_user, 'restricted.payment', 'SELECT') AS payment_select,
     has_table_privilege(current_user, 'processing_record', 'UPDATE') AS processing_update,
     has_table_privilege(current_user, 'processing_record', 'DELETE') AS processing_delete;"
```

The first result must show `agrawal_app` (or the configured `APP_DB_USER`) and
`true`. The four `*_insert` columns must be `true`; `payment_select`,
`processing_update`, and `processing_delete` must be `false`. A failed check is
a deployment failure: do not start or restart the API container until the
role-grant step is corrected.
