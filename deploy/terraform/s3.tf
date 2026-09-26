# ==============================================================================
# S3 Storage Configuration
#
# References:
#   - ADR-0017 (S3 for media storage)
#   - ADR-0028 (Web deployment on AWS: static web hosting via S3 + CloudFront)
#   - Issue #2 (Private S3 bucket with Block Public Access, encryption, lifecycle)
# ==============================================================================

# ------------------------------------------------------------------------------
# Settings shared by both buckets: Block Public Access (all four settings) and
# SSE-S3 (AES256) encryption at rest.
# ------------------------------------------------------------------------------

locals {
  private_buckets = {
    media = aws_s3_bucket.media.id
    web   = aws_s3_bucket.web.id
  }
}

resource "aws_s3_bucket_public_access_block" "private" {
  for_each = local.private_buckets
  bucket   = each.value

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "private" {
  for_each = local.private_buckets
  bucket   = each.value

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

moved {
  from = aws_s3_bucket_public_access_block.media
  to   = aws_s3_bucket_public_access_block.private["media"]
}

moved {
  from = aws_s3_bucket_public_access_block.web
  to   = aws_s3_bucket_public_access_block.private["web"]
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.media
  to   = aws_s3_bucket_server_side_encryption_configuration.private["media"]
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.web
  to   = aws_s3_bucket_server_side_encryption_configuration.private["web"]
}

# ------------------------------------------------------------------------------
# 1. Private Media Bucket (User photos, documents, Noticeboard attachments)
# ------------------------------------------------------------------------------

resource "aws_s3_bucket" "media" {
  bucket = "agrawal-${var.environment}-media-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name        = "agrawal-${var.environment}-media"
    Purpose     = "PrivateMediaStorage"
    Environment = var.environment
  }
}

# Object versioning for data loss protection
resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Lifecycle configuration: Abort failed uploads, expire old versions
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  # Rule 1: Clean up abandoned multipart uploads to avoid storage waste
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    filter {}
  }

  # Rule 2: Expire noncurrent object versions after 30 days
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    filter {}
  }
}

# ------------------------------------------------------------------------------
# 2. Static Web Assets Bucket (Frontend builds per ADR-0028)
# ------------------------------------------------------------------------------

resource "aws_s3_bucket" "web" {
  bucket = "agrawal-${var.environment}-web-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name        = "agrawal-${var.environment}-web"
    Purpose     = "StaticFrontendHosting"
    Environment = var.environment
  }
}

# S3 Bucket Policy: Only CloudFront via Origin Access Control (OAC) can read web assets
resource "aws_s3_bucket_policy" "web_oac_read" {
  bucket = aws_s3_bucket.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipalReadOnly"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.web.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
          }
        }
      }
    ]
  })
}
