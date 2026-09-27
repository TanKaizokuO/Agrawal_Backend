# ==============================================================================
# RDS PostgreSQL Database Configuration
#
# References:
#   - ADR-0017 (RDS PostgreSQL db.t3.small, Single-AZ, automated backups)
#   - ADR-0029 (PostgreSQL 18 is the pinned project database version)
#   - Issue #2 (Automated backups enabled with stated retention window; PITR)
#
# Security:
#   - Storage encrypted at rest with AWS KMS
#   - rds.force_ssl = "1" enforces TLS on all client connections
#   - Private subnets only; no public accessibility
#   - Access restricted to EC2 security group on port 5432
#   - Master user 'postgres' used only for bootstrap; runtime uses separated roles
# ==============================================================================

# Database Subnet Group across private subnets
resource "aws_db_subnet_group" "rds" {
  name        = "agrawal-${var.environment}-rds-subnet-group"
  description = "Subnet group for Agrawal Samaj RDS PostgreSQL instances"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "agrawal-${var.environment}-rds-subnet-group"
  }
}

# PostgreSQL 18 Parameter Group enforcing TLS and performance metrics
resource "aws_db_parameter_group" "pg18" {
  name        = "agrawal-${var.environment}-pg18-params"
  family      = "postgres18"
  description = "PostgreSQL 18 parameter group enforcing TLS and audit logging"

  # Enforce TLS on all incoming connections (sslmode=verify-full)
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Enable pg_stat_statements for query performance insights
  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }

  # Query and connection logging for security auditability
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # Log statements taking over 1,000 ms
  }

  tags = {
    Name = "agrawal-${var.environment}-pg18-params"
  }
}

# ------------------------------------------------------------------------------
# RDS PostgreSQL Instance
# ------------------------------------------------------------------------------

resource "aws_db_instance" "main" {
  identifier = "agrawal-${var.environment}-db"

  # Pinned per ADR-0029 (PostgreSQL 18)
  engine         = "postgres"
  engine_version = var.rds_engine_version
  instance_class = var.rds_instance_class

  # Storage configuration: 20 GB gp3 with autoscaling up to 100 GB
  allocated_storage     = var.rds_allocated_storage_gb
  max_allocated_storage = var.rds_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  # Database naming and bootstrap credentials
  db_name  = "agrawal_${var.environment}"
  username = "postgres"
  password = var.db_master_password
  port     = 5432

  # Architecture: Single-AZ per ADR-0017 pilot scale
  multi_az = false

  # Network isolation: Private subnets, inaccessible from public internet
  publicly_accessible    = false
  db_subnet_group_name   = aws_db_subnet_group.rds.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.pg18.name

  # Backup & PITR: Stated retention window per hard acceptance in Issue #2
  backup_retention_period    = var.rds_backup_retention_days
  backup_window              = "21:30-22:30"         # 03:00-04:00 IST (low traffic)
  maintenance_window         = "Sun:22:30-Sun:23:30" # Mon 04:00-05:00 IST
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true

  # Deletion protection enabled for production
  deletion_protection       = var.environment == "production" ? true : false
  skip_final_snapshot       = var.environment == "production" ? false : true
  final_snapshot_identifier = "agrawal-${var.environment}-db-final-snapshot"

  tags = {
    Name = "agrawal-${var.environment}-db"
  }
}
