# State: run one state per environment. Staging and production use the same
# configuration and resource names, so sharing a state would make one
# environment's apply destroy the other's resources. Local state works for a
# single operator; for shared use, add an S3 backend with a per-environment key:
#
#   terraform {
#     backend "s3" {}
#   }
#
#   tofu init -backend-config="bucket=<state-bucket>" \
#             -backend-config="key=agrawal/<staging|production>/terraform.tfstate" \
#             -backend-config="region=ap-south-1" \
#             -backend-config="use_lockfile=true"
#
# The state bucket must exist before init (create it once, outside this stack)
# and should have versioning and Block Public Access enabled.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "AgrawalSamaj"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# Provider alias for us-east-1 (required for CloudFront ACM certificate validation if used)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "AgrawalSamaj"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}
