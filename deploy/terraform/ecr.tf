# ==============================================================================
# Amazon ECR Container Repositories
#
# References:
#   - deploy/README.md §1 & §3 (Image Pull & ECR deployment)
#   - .github/workflows/api.yml (ECR_REPOSITORY_STAGING, ECR_REPOSITORY_PROD)
#   - REMAINING BACKEND WORK.md §3 (ECR repositories)
# ==============================================================================

# Common lifecycle policy to prune untagged images and keep last 10 versions
locals {
  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images older than 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Keep last 10 tagged deployment images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["api-v", "staging-"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# Staging ECR Repository
resource "aws_ecr_repository" "staging" {
  name                 = "agrawal-api-staging"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name        = "agrawal-api-staging"
    Environment = "staging"
  }
}

resource "aws_ecr_lifecycle_policy" "staging" {
  repository = aws_ecr_repository.staging.name
  policy     = local.ecr_lifecycle_policy
}

# Production ECR Repository
resource "aws_ecr_repository" "prod" {
  name                 = "agrawal-api-prod"
  image_tag_mutability = "IMMUTABLE" # Production images are immutable

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name        = "agrawal-api-prod"
    Environment = "production"
  }
}

resource "aws_ecr_lifecycle_policy" "prod" {
  repository = aws_ecr_repository.prod.name
  policy     = local.ecr_lifecycle_policy
}
