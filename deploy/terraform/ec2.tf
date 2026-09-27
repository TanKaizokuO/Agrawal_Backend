# ==============================================================================
# EC2 Application Host Configuration
#
# Provides the compute instance for Express API container and Caddy reverse proxy
# per ADR-0017 (t3.small, Single-AZ in ap-south-1).
# Access: SSH is closed; managed exclusively via AWS Systems Manager (SSM).
# ==============================================================================

# Latest Ubuntu 24.04 LTS Noble Numbat AMI in ap-south-1
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ------------------------------------------------------------------------------
# IAM Role and Instance Profile
# ------------------------------------------------------------------------------

resource "aws_iam_role" "ec2_role" {
  name = "agrawal-${var.environment}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "agrawal-${var.environment}-ec2-role"
  }
}

# Attach AWS managed policy for SSM Session Manager & Run Command
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Attach AWS managed policy for reading container images from ECR
resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Least-privilege inline policy: SSM Parameter Store access + KMS Decrypt + S3 Media
resource "aws_iam_role_policy" "ec2_app_policy" {
  name = "agrawal-${var.environment}-ec2-app-policy"
  role = aws_iam_role.ec2_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SSMParameterAccess"
        Effect = "Allow"
        Action = [
          "ssm:GetParameters",
          "ssm:GetParameter",
          "ssm:GetParametersByPath"
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/agrawal/${var.environment}/*",
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/agrawal/${var.environment}"
        ]
      },
      {
        Sid    = "KMSDecryptAccess"
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = [
          aws_kms_key.ssm.arn
        ]
      },
      {
        Sid    = "S3MediaBucketAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.media.arn,
          "${aws_s3_bucket.media.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "agrawal-${var.environment}-ec2-profile"
  role = aws_iam_role.ec2_role.name
}

# ------------------------------------------------------------------------------
# EC2 Application Instance
# ------------------------------------------------------------------------------

resource "aws_instance" "api" {
  ami                  = data.aws_ami.ubuntu.id
  instance_type        = var.ec2_instance_type
  subnet_id            = aws_subnet.public[0].id
  iam_instance_profile = aws_iam_instance_profile.ec2_profile.name

  vpc_security_group_ids = [aws_security_group.ec2.id]

  # data.aws_ami.ubuntu tracks the newest Noble image; without this every new
  # Canonical release would plan a replacement of the API host. Roll the AMI
  # deliberately with `tofu apply -replace=aws_instance.api`.
  lifecycle {
    ignore_changes = [ami]
  }

  # Root block volume: gp3 20 GB encrypted
  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.ec2_root_volume_size_gb
    encrypted             = true
    delete_on_termination = true

    tags = {
      Name = "agrawal-${var.environment}-ec2-root-vol"
    }
  }

  user_data = <<-EOF
              #!/bin/bash
              set -euo pipefail

              # Update system packages
              apt-get update -y
              apt-get upgrade -y
              apt-get install -y ca-certificates curl gnupg lsb-release unzip jq

              # Install AWS Systems Manager (SSM) Agent (snap or deb)
              snap install amazon-ssm-agent --classic || true
              systemctl enable snap.amazon-ssm-agent.amazon-ssm-agent.service || true
              systemctl start snap.amazon-ssm-agent.amazon-ssm-agent.service || true

              # Install AWS CLI v2
              curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
              unzip -q awscliv2.zip
              ./aws/install
              rm -rf aws awscliv2.zip

              # Install Docker and Docker Compose plugin
              install -m 0755 -d /etc/apt/keyrings
              curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
              chmod a+r /etc/apt/keyrings/docker.asc

              echo \
                "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
                $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
                tee /etc/apt/sources.list.d/docker.list > /dev/null

              apt-get update -y
              apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

              systemctl enable docker
              systemctl start docker

              # Setup application deployment directory per deploy.sh and README.md
              mkdir -p /opt/agrawal/deploy
              chmod 750 /opt/agrawal
              chmod 750 /opt/agrawal/deploy

              echo "EC2 host initialization completed successfully at $(date -u)"
              EOF

  tags = {
    Name = "agrawal-${var.environment}-api-host"
  }
}

# Dedicated Elastic IP for static inbound addressing
resource "aws_eip" "api_eip" {
  instance = aws_instance.api.id
  domain   = "vpc"

  tags = {
    Name = "agrawal-${var.environment}-api-eip"
  }
}
