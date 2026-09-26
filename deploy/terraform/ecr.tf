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

# Each environment's stack manages only its own repository, so a staging apply
# can never modify or destroy the production registry. Repository names are
# unchanged; .github/workflows/api.yml pushes to them by name.
resource "aws_ecr_repository" "staging" {
  count                = local.is_production ? 0 : 1
  name                 = "agrawal-api-staging"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = "agrawal-api-staging"
  }
}

resource "aws_ecr_lifecycle_policy" "staging" {
  count      = local.is_production ? 0 : 1
  repository = aws_ecr_repository.staging[0].name
  policy     = local.ecr_lifecycle_policy
}

resource "aws_ecr_repository" "prod" {
  count                = local.is_production ? 1 : 0
  name                 = "agrawal-api-prod"
  image_tag_mutability = "IMMUTABLE" # Production images are immutable

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = "agrawal-api-prod"
  }
}

resource "aws_ecr_lifecycle_policy" "prod" {
  count      = local.is_production ? 1 : 0
  repository = aws_ecr_repository.prod[0].name
  policy     = local.ecr_lifecycle_policy
}
