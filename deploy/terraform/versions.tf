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
