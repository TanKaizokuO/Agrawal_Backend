# ==============================================================================
# VPC and Networking Configuration
#
# Provides isolated network infrastructure for Agrawal Samaj in ap-south-1.
# - Public subnets across 2 AZs for EC2 compute and ingress
# - Private subnets across 2 AZs for RDS PostgreSQL database tier
# - Strict security group rules: SSH closed; RDS accessible ONLY from EC2 SG
# ==============================================================================

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "agrawal-${var.environment}-vpc"
  }
}

resource "aws_internet_gateway" "gw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "agrawal-${var.environment}-igw"
  }
}

# ------------------------------------------------------------------------------
# Subnets
# ------------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "agrawal-${var.environment}-public-subnet-${count.index + 1}"
    Tier = "Public"
  }
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name = "agrawal-${var.environment}-private-subnet-${count.index + 1}"
    Tier = "Private"
  }
}

# ------------------------------------------------------------------------------
# Route Tables & Associations
# ------------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.gw.id
  }

  tags = {
    Name = "agrawal-${var.environment}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "agrawal-${var.environment}-private-rt"
  }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ------------------------------------------------------------------------------
# Security Groups
# ------------------------------------------------------------------------------

# EC2 Security Group: Ingress 80/443; SSH is CLOSED per architecture (SSM only)
resource "aws_security_group" "ec2" {
  name        = "agrawal-${var.environment}-ec2-sg"
  description = "Security group for Agrawal Samaj EC2 API host"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP for Caddy ACME verification and redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS for TLS API and web reverse proxy"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # NOTE: SSH (port 22) is NOT allowed. Access and deployments are performed
  # exclusively via AWS Systems Manager (SSM) Session Manager and Run Command
  # per ADR-0017 and deploy/README.md.

  egress {
    description = "Allow all outbound traffic (SSM, ECR, OS updates, external APIs)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "agrawal-${var.environment}-ec2-sg"
  }
}

# RDS Security Group: Strictly isolated; PostgreSQL port 5432 from EC2 only
resource "aws_security_group" "rds" {
  name        = "agrawal-${var.environment}-rds-sg"
  description = "Security group for Agrawal Samaj RDS PostgreSQL instance"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL access exclusively from EC2 application instance"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  egress {
    description = "No outbound traffic permitted from database tier"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "agrawal-${var.environment}-rds-sg"
  }
}
