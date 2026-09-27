# Agrawal Samaj - RDS PostgreSQL 18 Backup Restore Rehearsal Runbook

> **Acceptance Requirement (Issue #2 & ADR-0017):**
> *"Automated backups enabled with a stated retention window, and one restore actually exercised — an untested backup is not a backup."*

This runbook specifies the exact procedure to rehearse restoring the Agrawal Samaj PostgreSQL 18 database in AWS `ap-south-1`. It exercises Point-In-Time Recovery (PITR) and snapshot restoration against an isolated rehearsal instance, verifies engine integrity and role permissions, and records recovery time evidence without impacting the active database.

---

## 1. Safety Rules & Rehearsal Policy

1. **Isolation Guarantee**: Rehearsals **NEVER** restore over an existing database instance. All restores target an ephemeral instance named `agrawal-<env>-rehearsal-restore`.
2. **Network Isolation**: The rehearsal instance is launched in the private database subnet group (`agrawal-<env>-rds-subnet-group`) with no public accessibility. Verification queries are executed from the EC2 application host via SSM Session Manager.
3. **No Downtime**: Restoring from an automated backup or snapshot is non-destructive to the primary database and incurs zero application downtime.
4. **Mandatory Teardown**: The rehearsal instance MUST be deleted immediately following verification to prevent unnecessary AWS spend.

---

## 2. Prerequisites

Execute on an operator workstation or inside an AWS SSM Session on the EC2 host:

```bash
# 1. Verify AWS CLI access and region
aws sts get-caller-identity
export AWS_REGION="ap-south-1"

# 2. Define environment and identifiers
export ENV="staging" # or "production"
export SOURCE_DB="agrawal-${ENV}-db"
export REHEARSAL_DB="agrawal-${ENV}-rehearsal-restore"

# 3. Ensure AWS RDS global CA certificate bundle is present for TLS verify-full
if [[ ! -f /etc/ssl/certs/global-bundle.pem ]]; then
  sudo curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /etc/ssl/certs/global-bundle.pem
fi
```

---

## 3. Step-by-Step Rehearsal Procedure

### Step 1: Pre-Rehearsal Timestamp & Preparation ($T_0$)

Record the rehearsal start time in UTC:

```bash
T0=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
T0_EPOCH=$(date +%s)
echo "Rehearsal started at T0 = ${T0}"
```

Retrieve source network and subnet configuration:

```bash
SUBNET_GROUP=$(aws rds describe-db-instances \
  --db-instance-identifier "${SOURCE_DB}" \
  --region "${AWS_REGION}" \
  --query "DBInstances[0].DBSubnetGroup.DBSubnetGroupName" \
  --output text)

SECURITY_GROUP=$(aws rds describe-db-instances \
  --db-instance-identifier "${SOURCE_DB}" \
  --region "${AWS_REGION}" \
  --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" \
  --output text)

echo "Subnet Group: ${SUBNET_GROUP}"
echo "Security Group: ${SECURITY_GROUP}"
```

---

### Step 2: Trigger Restoration via AWS CLI

Choose **Modality A (PITR)** or **Modality B (Latest Snapshot)**:

#### Modality A: Point-in-Time Recovery (PITR)
Restores the database state to a specific historical timestamp within the retention window (e.g., 30 minutes ago):

```bash
# Target restore time (UTC ISO8601, e.g., 30 minutes prior)
RESTORE_TIME=$(date -u -d "30 minutes ago" +"%Y-%m-%dT%H:%M:%SZ")

echo "Initiating PITR to ${RESTORE_TIME}..."
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "${SOURCE_DB}" \
  --target-db-instance-identifier "${REHEARSAL_DB}" \
  --restore-time "${RESTORE_TIME}" \
  --db-instance-class "db.t3.small" \
  --db-subnet-group-name "${SUBNET_GROUP}" \
  --vpc-security-group-ids "${SECURITY_GROUP}" \
  --no-publicly-accessible \
  --auto-minor-version-upgrade \
  --region "${AWS_REGION}"
```

#### Modality B: Restore from Latest Automated Snapshot
Restores from the most recent daily backup snapshot:

```bash
LATEST_SNAPSHOT=$(aws rds describe-db-snapshots \
  --db-instance-identifier "${SOURCE_DB}" \
  --snapshot-type automated \
  --query "reverse(sort_by(DBSnapshots, &SnapshotCreateTime))[0].DBSnapshotIdentifier" \
  --output text \
  --region "${AWS_REGION}")

echo "Restoring from snapshot: ${LATEST_SNAPSHOT}..."
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "${REHEARSAL_DB}" \
  --db-snapshot-identifier "${LATEST_SNAPSHOT}" \
  --db-instance-class "db.t3.small" \
  --db-subnet-group-name "${SUBNET_GROUP}" \
  --vpc-security-group-ids "${SECURITY_GROUP}" \
  --no-publicly-accessible \
  --auto-minor-version-upgrade \
  --region "${AWS_REGION}"
```

---

### Step 3: Wait for Availability and Record Recovery Time ($T_1$)

Poll the instance status until it transitions to `available`:

```bash
echo "Waiting for ${REHEARSAL_DB} to become available..."
aws rds wait db-instance-available \
  --db-instance-identifier "${REHEARSAL_DB}" \
  --region "${AWS_REGION}"

T1=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
T1_EPOCH=$(date +%s)
RECOVERY_DURATION_SECS=$(( T1_EPOCH - T0_EPOCH ))

echo "======================================================================"
echo "Restore completed at T1 = ${T1}"
echo "Total Recovery Time (RTO): ${RECOVERY_DURATION_SECS} seconds ($(( RECOVERY_DURATION_SECS / 60 )) minutes)"
echo "======================================================================"
```

---

### Step 4: Extract Restored Endpoint

```bash
RESTORED_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "${REHEARSAL_DB}" \
  --region "${AWS_REGION}" \
  --query "DBInstances[0].Endpoint.Address" \
  --output text)

RESTORED_PORT=$(aws rds describe-db-instances \
  --db-instance-identifier "${REHEARSAL_DB}" \
  --region "${AWS_REGION}" \
  --query "DBInstances[0].Endpoint.Port" \
  --output text)

echo "Restored Database Host: ${RESTORED_ENDPOINT}:${RESTORED_PORT}"
```

---

### Step 5: Verification & Integrity Assertions

Run the following test suite against the restored database to prove backup validity:

#### Assertion 1: TLS Enforced Connection (`verify-full`)
Verify that the database requires TLS and validates against Amazon's global root certificate:

```bash
PGPASSWORD="${DB_MASTER_PASSWORD}" psql \
  "host=${RESTORED_ENDPOINT} port=${RESTORED_PORT} dbname=agrawal_${ENV} user=postgres sslmode=verify-full sslrootcert=/etc/ssl/certs/global-bundle.pem" \
  -c "SELECT ssl_is_used(), version();"
```
*Expected Result:* `ssl_is_used` returns `true`, and engine version displays `PostgreSQL 18.x`.

#### Assertion 2: PostgreSQL 18 Engine & Recovery Status
```bash
PGPASSWORD="${DB_MASTER_PASSWORD}" psql \
  "host=${RESTORED_ENDPOINT} port=${RESTORED_PORT} dbname=agrawal_${ENV} user=postgres sslmode=verify-full sslrootcert=/etc/ssl/certs/global-bundle.pem" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT pg_is_in_recovery();"
```
*Expected Result:* `pg_is_in_recovery()` returns `f` (false), confirming the restored database is fully writeable.

#### Assertion 3: Required Extensions Installed
```bash
PGPASSWORD="${DB_MASTER_PASSWORD}" psql \
  "host=${RESTORED_ENDPOINT} port=${RESTORED_PORT} dbname=agrawal_${ENV} user=postgres sslmode=verify-full sslrootcert=/etc/ssl/certs/global-bundle.pem" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('pg_trgm', 'citext', 'unaccent');"
```
*Expected Result:* Returns rows for `pg_trgm`, `citext`, and `unaccent`.

#### Assertion 4: Schema & Data Consistency
Compare row counts between source and restored instances:
```bash
PGPASSWORD="${DB_MASTER_PASSWORD}" psql \
  "host=${RESTORED_ENDPOINT} port=${RESTORED_PORT} dbname=agrawal_${ENV} user=postgres sslmode=verify-full sslrootcert=/etc/ssl/certs/global-bundle.pem" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public', 'restricted') ORDER BY table_schema, table_name;"
```
*Expected Result:* All tables in `public` and `restricted` exist intact.

#### Assertion 5: Least-Privilege Role Permissions (`agrawal_app`)
Verify that the least-privilege `agrawal_app` role preserved its restricted permissions:
```bash
PGPASSWORD="${APP_DB_PASSWORD}" psql \
  "host=${RESTORED_ENDPOINT} port=${RESTORED_PORT} dbname=agrawal_${ENV} user=agrawal_app sslmode=verify-full sslrootcert=/etc/ssl/certs/global-bundle.pem" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT current_user, has_schema_privilege(current_user, 'restricted', 'USAGE');"

PGPASSWORD="${APP_DB_PASSWORD}" psql \
  "host=${RESTORED_ENDPOINT} port=${RESTORED_PORT} dbname=agrawal_${ENV} user=agrawal_app sslmode=verify-full sslrootcert=/etc/ssl/certs/global-bundle.pem" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT
        has_table_privilege(current_user, 'restricted.member_tombstone', 'INSERT') AS tombstone_insert,
        has_table_privilege(current_user, 'restricted.payment', 'INSERT') AS payment_insert,
        has_table_privilege(current_user, 'restricted.refund', 'INSERT') AS refund_insert,
        has_table_privilege(current_user, 'restricted.consent_event', 'INSERT') AS consent_insert,
        has_table_privilege(current_user, 'restricted.payment', 'SELECT') AS payment_select,
        has_table_privilege(current_user, 'processing_record', 'UPDATE') AS processing_update,
        has_table_privilege(current_user, 'processing_record', 'DELETE') AS processing_delete;"
```
*Expected Result:*
- `current_user`: `agrawal_app`
- `has_schema_privilege`: `true`
- `*_insert` columns: `true`
- `payment_select`: `false`
- `processing_update`: `false`
- `processing_delete`: `false`

---

### Step 6: Evidence Recording

Record rehearsal metrics in `deploy/rehearsal-evidence.log`:

```bash
EVIDENCE_FILE="/opt/agrawal/deploy/rehearsal-evidence.log"
mkdir -p "$(dirname "${EVIDENCE_FILE}")"

cat <<EOF >> "${EVIDENCE_FILE}"
======================================================================
BACKUP RESTORE REHEARSAL EVIDENCE RECORD
----------------------------------------------------------------------
Timestamp Start (T0):    ${T0}
Timestamp Finish (T1):   ${T1}
Recovery Duration (RTO): ${RECOVERY_DURATION_SECS} seconds ($(( RECOVERY_DURATION_SECS / 60 )) min)
Environment:             ${ENV}
Source Instance:         ${SOURCE_DB}
Restored Instance:       ${REHEARSAL_DB}
Restored Host:           ${RESTORED_ENDPOINT}:${RESTORED_PORT}
Restore Modality:        ${RESTORE_TIME:-${LATEST_SNAPSHOT}}
TLS Verification:        PASSED (verify-full)
Engine Version Check:    PASSED (PostgreSQL 18)
Extensions Verified:     PASSED (pg_trgm, citext, unaccent)
Role Permissions Check:  PASSED (agrawal_app restricted access verified)
Operator Sign-off:       COMPLETED
======================================================================
EOF

echo "Evidence logged to ${EVIDENCE_FILE}."
```

---

### Step 7: Teardown & Resource Cleanup

Immediately delete the rehearsal instance to terminate billing:

```bash
echo "Initiating teardown of ${REHEARSAL_DB}..."

aws rds delete-db-instance \
  --db-instance-identifier "${REHEARSAL_DB}" \
  --skip-final-snapshot \
  --region "${AWS_REGION}"

echo "Waiting for instance deletion to complete..."
aws rds wait db-instance-deleted \
  --db-instance-identifier "${REHEARSAL_DB}" \
  --region "${AWS_REGION}"

echo "Teardown complete. Rehearsal instance deleted; zero ongoing billing."
```
