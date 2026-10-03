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
  value       = join(",", local.web_origins)

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

locals {
  # Parameter name => settings. Terraform creates each with a placeholder once;
  # operators set the real value out-of-band and ignore_changes keeps it.
  operator_parameters = {
    FIREBASE_PROJECT_ID                 = { secure = false, description = "Firebase Project ID for Phone Authentication" }
    FIREBASE_SERVICE_ACCOUNT_JSON       = { secure = true, description = "Firebase Service Account JSON credentials" }
    SMS_PROVIDER                        = { secure = false, description = "`msg91` for production; `console` dev-only" }
    MSG91_AUTH_KEY                      = { secure = true, description = "MSG91 Flow API credentials" }
    MSG91_TEMPLATE_ID                   = { secure = false, description = "MSG91 Flow template mapped to DLT template ID" }
    MSG91_OTP_VAR                       = { secure = false, description = "template OTP variable name, default `otp`" }
    OTP_HMAC_KEY                        = { secure = true, description = "HMAC-SHA256 key for OTP verification hashes" }
    RAZORPAY_KEY_ID                     = { secure = true, description = "Razorpay Key ID" }
    RAZORPAY_KEY_SECRET                 = { secure = true, description = "Razorpay Key Secret" }
    RAZORPAY_WEBHOOK_SECRET             = { secure = true, description = "Razorpay Webhook verification secret" }
    PAYMENT_IDENTITY_HMAC_KEY           = { secure = true, description = "32 random bytes, base64-encoded, for payment identity HMAC hashing" }
    GOOGLE_CLOUD_PROJECT                = { secure = false, description = "Google Cloud Project ID for Translation / romanizeText" }
    GOOGLE_APPLICATION_CREDENTIALS_JSON = { secure = true, description = "Google Cloud service account JSON credentials" }
    EVENT_PASS_SIGNING_KEYS             = { secure = true, description = "JSON array of Ed25519 signing keys for Event Passes" }
    SIGHTENGINE_API_USER                = { secure = false, description = "Sightengine API User ID" }
    SIGHTENGINE_API_SECRET              = { secure = true, description = "Sightengine API Secret" }
  }
}

resource "aws_ssm_parameter" "operator" {
  for_each    = local.operator_parameters
  name        = "/agrawal/${var.environment}/${each.key}"
  description = each.value.description
  type        = each.value.secure ? "SecureString" : "String"
  key_id      = each.value.secure ? aws_kms_key.ssm.arn : null
  value       = "PLACEHOLDER_SET_BY_OPERATOR"

  lifecycle {
    ignore_changes = [value]
  }
}

moved {
  from = aws_ssm_parameter.firebase_project_id
  to   = aws_ssm_parameter.operator["FIREBASE_PROJECT_ID"]
}

moved {
  from = aws_ssm_parameter.firebase_service_account
  to   = aws_ssm_parameter.operator["FIREBASE_SERVICE_ACCOUNT_JSON"]
}

moved {
  from = aws_ssm_parameter.razorpay_key_id
  to   = aws_ssm_parameter.operator["RAZORPAY_KEY_ID"]
}

moved {
  from = aws_ssm_parameter.razorpay_key_secret
  to   = aws_ssm_parameter.operator["RAZORPAY_KEY_SECRET"]
}

moved {
  from = aws_ssm_parameter.razorpay_webhook_secret
  to   = aws_ssm_parameter.operator["RAZORPAY_WEBHOOK_SECRET"]
}

moved {
  from = aws_ssm_parameter.payment_hmac_key
  to   = aws_ssm_parameter.operator["PAYMENT_IDENTITY_HMAC_KEY"]
}

moved {
  from = aws_ssm_parameter.google_cloud_project
  to   = aws_ssm_parameter.operator["GOOGLE_CLOUD_PROJECT"]
}

moved {
  from = aws_ssm_parameter.google_application_credentials
  to   = aws_ssm_parameter.operator["GOOGLE_APPLICATION_CREDENTIALS_JSON"]
}

moved {
  from = aws_ssm_parameter.event_pass_signing_keys
  to   = aws_ssm_parameter.operator["EVENT_PASS_SIGNING_KEYS"]
}

moved {
  from = aws_ssm_parameter.sightengine_api_user
  to   = aws_ssm_parameter.operator["SIGHTENGINE_API_USER"]
}

moved {
  from = aws_ssm_parameter.sightengine_api_secret
  to   = aws_ssm_parameter.operator["SIGHTENGINE_API_SECRET"]
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
