# ==============================================================================
# KMS and AWS SSM Parameter Store Configuration
#
# References:
#   - deploy/README.md §2 (Secrets & Configuration: /agrawal/<env>/<KEY>)
#   - Issue #2 (SSM Parameter Store SecureString under /agrawal/<env>/ with KMS)
#   - Invariant: Never commit credentials to source control.
# ==============================================================================

# Customer Managed KMS Key for SSM Parameter Store encryption
resource "aws_kms_key" "ssm" {
  description             = "KMS CMK for Agrawal Samaj SSM Parameter Store (${var.environment})"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableRootIAMUserPermissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowEC2RoleDecrypt"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.ec2_role.arn
        }
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = "*"
      }
    ]
  })

  tags = {
    Name        = "agrawal-${var.environment}-ssm-kms"
    Environment = var.environment
  }
}

resource "aws_kms_alias" "ssm_alias" {
  name          = "alias/agrawal-${var.environment}-ssm"
  target_key_id = aws_kms_key.ssm.key_id
}

# ------------------------------------------------------------------------------
# Auto-Populated Infrastructure Parameters
# ------------------------------------------------------------------------------

# Database URL for least-privilege runtime application role (agrawal_app)
# Enforces TLS verify-full per repository requirements
resource "aws_ssm_parameter" "database_url" {
  name        = "/agrawal/${var.environment}/DATABASE_URL"
  description = "Runtime application database connection string (agrawal_app role)"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "postgresql://agrawal_app:${var.app_db_password}@${aws_db_instance.main.endpoint}/agrawal_${var.environment}?schema=public&sslmode=verify-full&sslrootcert=/etc/ssl/certs/global-bundle.pem"

  tags = {
    Environment = var.environment
  }
}

# Database Migration URL for migration-owner role (agrawal_owner)
# Used solely by 'prisma migrate deploy' in ephemeral container
resource "aws_ssm_parameter" "database_migration_url" {
  name        = "/agrawal/${var.environment}/DATABASE_MIGRATION_URL"
  description = "Migration owner database connection string for prisma migrate deploy"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "postgresql://agrawal_owner:${var.migration_db_password}@${aws_db_instance.main.endpoint}/agrawal_${var.environment}?schema=public&sslmode=verify-full&sslrootcert=/etc/ssl/certs/global-bundle.pem"

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "web_origins" {
  name        = "/agrawal/${var.environment}/WEB_ORIGINS"
  description = "Allowed web origins for CORS and CSRF checks"
  type        = "String"
  value       = "https://${var.domain_name},https://register.${var.domain_name},https://api.${var.domain_name}"

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "s3_bucket" {
  name        = "/agrawal/${var.environment}/S3_BUCKET"
  description = "Private S3 bucket name for uploads and media"
  type        = "String"
  value       = aws_s3_bucket.media.id

  tags = {
    Environment = var.environment
  }
}

# ------------------------------------------------------------------------------
# Operator-Supplied Vendor Secrets (Placeholders provisioned with lifecycle ignore)
# Operators populate real values out-of-band via AWS CLI / Console.
# ------------------------------------------------------------------------------

resource "aws_ssm_parameter" "firebase_project_id" {
  name        = "/agrawal/${var.environment}/FIREBASE_PROJECT_ID"
  description = "Firebase Project ID for Phone Authentication"
  type        = "String"
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "firebase_service_account" {
  name        = "/agrawal/${var.environment}/FIREBASE_SERVICE_ACCOUNT_JSON"
  description = "Firebase Service Account JSON credentials"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "razorpay_key_id" {
  name        = "/agrawal/${var.environment}/RAZORPAY_KEY_ID"
  description = "Razorpay Key ID"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "razorpay_key_secret" {
  name        = "/agrawal/${var.environment}/RAZORPAY_KEY_SECRET"
  description = "Razorpay Key Secret"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "razorpay_webhook_secret" {
  name        = "/agrawal/${var.environment}/RAZORPAY_WEBHOOK_SECRET"
  description = "Razorpay Webhook verification secret"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "payment_hmac_key" {
  name        = "/agrawal/${var.environment}/PAYMENT_IDENTITY_HMAC_KEY"
  description = "32 random bytes, base64-encoded, for payment identity HMAC hashing"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "google_cloud_project" {
  name        = "/agrawal/${var.environment}/GOOGLE_CLOUD_PROJECT"
  description = "Google Cloud Project ID for Translation / romanizeText"
  type        = "String"
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "google_application_credentials" {
  name        = "/agrawal/${var.environment}/GOOGLE_APPLICATION_CREDENTIALS_JSON"
  description = "Google Cloud service account JSON credentials"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "event_pass_signing_keys" {
  name        = "/agrawal/${var.environment}/EVENT_PASS_SIGNING_KEYS"
  description = "JSON array of Ed25519 signing keys for Event Passes"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "sightengine_api_user" {
  name        = "/agrawal/${var.environment}/SIGHTENGINE_API_USER"
  description = "Sightengine API User ID"
  type        = "String"
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "sightengine_api_secret" {
  name        = "/agrawal/${var.environment}/SIGHTENGINE_API_SECRET"
  description = "Sightengine API Secret"
  type        = "SecureString"
  key_id      = aws_kms_key.ssm.arn
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "erasure_self_service" {
  name        = "/agrawal/${var.environment}/ERASURE_SELF_SERVICE"
  description = "Self-service erasure enablement flag"
  type        = "String"
  value       = "false"

  lifecycle {
    ignore_changes = [value]
  }
}
