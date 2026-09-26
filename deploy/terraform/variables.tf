# ==============================================================================
# Agrawal Samaj - Terraform Variables
#
# References:
#   - ADR-0017 (Hosting: EC2, RDS db.t3.small Single-AZ, S3, CloudFront)
#   - ADR-0028 (Web Deployment on AWS)
#   - ADR-0029 (PostgreSQL 18)
#   - Issue #2 (Provision AWS environment and hosted domain)
#   - Issue #13 (Operator inputs owed: Domain name, etc.)
# ==============================================================================

# ------------------------------------------------------------------------------
# REQUIRED VARIABLES (NO DEFAULT - MUST BE SUPPLIED BY OPERATOR)
# ------------------------------------------------------------------------------

variable "domain_name" {
  description = "Authoritative hosted domain name (e.g., agrawal.app). Tracked in Issue #13 as an open operator decision. MUST NOT be hardcoded or defaulted."
  type        = string
}

variable "db_master_password" {
  description = "Master user (postgres) password for the RDS PostgreSQL instance. Must be at least 16 characters. Secrets must never be committed to git."
  type        = string
  sensitive   = true
}

variable "app_db_password" {
  description = "Password for the least-privilege runtime application database role (agrawal_app)."
  type        = string
  sensitive   = true
}

variable "migration_db_password" {
  description = "Password for the migration-owner database role (agrawal_owner)."
  type        = string
  sensitive   = true
}

variable "operator_email" {
  description = "Operator contact email address used for ACME TLS certificate notifications and cloud alarms."
  type        = string
}

# ------------------------------------------------------------------------------
# CONFIGURABLE VARIABLES WITH SAFE DEFAULTS
# ------------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region for all regional resources (compute, database, storage)."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Deployment target environment (staging or production)."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be either 'staging' or 'production'."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the dedicated application VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Availability zones in the target region for multi-AZ VPC layout."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (EC2, ingress)."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets (RDS database subnet group)."
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24"]
}

variable "ec2_instance_type" {
  description = "EC2 instance size for the API and reverse proxy host per ADR-0017."
  type        = string
  default     = "t3.small"
}

variable "ec2_root_volume_size_gb" {
  description = "Size of the root EBS gp3 volume in GB."
  type        = number
  default     = 20
}

variable "rds_instance_class" {
  description = "RDS DB instance class per ADR-0017 (db.t3.small)."
  type        = string
  default     = "db.t3.small"
}

variable "rds_engine_version" {
  description = "PostgreSQL engine version on RDS pinned by ADR-0029."
  type        = string
  default     = "18.3"
}

variable "rds_allocated_storage_gb" {
  description = "Initial allocated gp3 storage for RDS in GB."
  type        = number
  default     = 20
}

variable "rds_max_allocated_storage_gb" {
  description = "Maximum storage threshold for RDS storage autoscaling in GB."
  type        = number
  default     = 100
}

variable "rds_backup_retention_days" {
  description = "Stated retention window in days for automated backups and Point-In-Time Recovery (PITR)."
  type        = number
  default     = 35
}

variable "acm_certificate_arn" {
  description = "Optional ARN of an existing AWS Certificate Manager (ACM) certificate in us-east-1 for CloudFront. If empty, CloudFront default certificate is used until DNS validation is completed."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Optional Route 53 hosted zone ID for the domain. If provided, alias DNS records will be configured."
  type        = string
  default     = ""
}
