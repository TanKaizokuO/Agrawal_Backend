# ==============================================================================
# Terraform Outputs
#
# Provides essential resource identifiers and connection endpoints for
# CI/CD pipelines (GitHub Actions) and operational runbooks.
# ==============================================================================

output "ec2_instance_id" {
  description = "EC2 Instance ID (used for GitHub Secrets: STAGING_EC2_INSTANCE_ID / PROD_EC2_INSTANCE_ID)"
  value       = aws_instance.api.id
}

output "ec2_elastic_ip" {
  description = "Static public Elastic IP address for the EC2 host (A record target)"
  value       = aws_eip.api_eip.public_ip
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint address (hostname:port)"
  value       = aws_db_instance.main.endpoint
}

output "rds_address" {
  description = "RDS PostgreSQL hostname"
  value       = aws_db_instance.main.address
}

output "rds_port" {
  description = "RDS PostgreSQL port"
  value       = aws_db_instance.main.port
}

output "rds_database_name" {
  description = "RDS database name"
  value       = aws_db_instance.main.db_name
}

output "s3_media_bucket_name" {
  description = "Private S3 media bucket name (SSM parameter S3_BUCKET)"
  value       = aws_s3_bucket.media.id
}

output "s3_media_bucket_arn" {
  description = "Private S3 media bucket ARN"
  value       = aws_s3_bucket.media.arn
}

output "s3_web_bucket_name" {
  description = "S3 static web frontend bucket name"
  value       = aws_s3_bucket.web.id
}

output "s3_web_bucket_arn" {
  description = "S3 static web frontend bucket ARN"
  value       = aws_s3_bucket.web.arn
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (used for cache invalidations in web deploy)"
  value       = aws_cloudfront_distribution.main.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name (*.cloudfront.net)"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "kms_key_arn" {
  description = "KMS Customer Managed Key ARN for SSM Parameter Store"
  value       = aws_kms_key.ssm.arn
}

output "kms_key_alias" {
  description = "KMS Customer Managed Key Alias"
  value       = aws_kms_alias.ssm_alias.name
}

output "ecr_repository_url" {
  description = "Amazon ECR repository URL for this environment's images"
  value       = local.is_production ? aws_ecr_repository.prod[0].repository_url : aws_ecr_repository.staging[0].repository_url
}

output "ssm_parameter_prefix" {
  description = "Prefix for AWS SSM Parameter Store hierarchy"
  value       = "/agrawal/${var.environment}/"
}
