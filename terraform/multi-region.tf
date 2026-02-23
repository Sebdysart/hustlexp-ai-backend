# ============================================================================
# Multi-Region Deployment Configuration
# ============================================================================
# Primary: us-east-1 (Virginia)
# Secondary: eu-west-1 (Ireland) for GDPR compliance
# Tertiary: ap-southeast-1 (Singapore) for APAC expansion

# Primary Region (US)
resource "aws_ecs_service" "hustlexp_api_us" {
  provider = aws.us-east-1
  name     = "hustlexp-api-us"
  cluster  = aws_ecs_cluster.hustlexp_us.id
  # ... (full config from audit)
}

# Secondary Region (EU) - GDPR Compliance
resource "aws_ecs_service" "hustlexp_api_eu" {
  provider = aws.eu-west-1
  name     = "hustlexp-api-eu"
  cluster  = aws_ecs_cluster.hustlexp_eu.id
  
  # EU-specific configuration for GDPR
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  
  tags = {
    Region = "eu-west-1"
    GDPR   = "compliant"
  }
}

# Route53 Latency-Based Routing
resource "aws_route53_record" "api_latency" {
  zone_id = aws_route53_zone.hustlexp.zone_id
  name    = "api.hustlexp.com"
  type    = "A"
  
  latency_routing_policy {
    region = "us-east-1"
  }
  
  alias {
    name                   = aws_lb.hustlexp_us.dns_name
    zone_id                = aws_lb.hustlexp_us.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api_latency_eu" {
  zone_id = aws_route53_zone.hustlexp.zone_id
  name    = "api.hustlexp.com"
  type    = "A"
  
  latency_routing_policy {
    region = "eu-west-1"
  }
  
  alias {
    name                   = aws_lb.hustlexp_eu.dns_name
    zone_id                = aws_lb.hustlexp_eu.zone_id
    evaluate_target_health = true
  }
}

# Database Replication
resource "aws_rds_global_cluster" "hustlexp" {
  global_cluster_identifier = "hustlexp-global"
  engine                    = "aurora-postgresql"
  engine_version            = "15.4"
  database_name             = "hustlexp"
  storage_encrypted         = true
}

resource "aws_rds_cluster" "hustlexp_us" {
  provider               = aws.us-east-1
  cluster_identifier     = "hustlexp-us"
  global_cluster_identifier = aws_rds_global_cluster.hustlexp.id
  engine                 = "aurora-postgresql"
  engine_version         = "15.4"
  database_name          = "hustlexp"
  master_username        = var.db_username
  master_password        = var.db_password
  backup_retention_period = 35
  preferred_backup_window = "03:00-04:00"
  
  vpc_security_group_ids = [aws_security_group.rds_us.id]
}

resource "aws_rds_cluster" "hustlexp_eu" {
  provider               = aws.eu-west-1
  cluster_identifier     = "hustlexp-eu"
  global_cluster_identifier = aws_rds_global_cluster.hustlexp.id
  engine                 = "aurora-postgresql"
  engine_version         = "15.4"
  
  vpc_security_group_ids = [aws_security_group.rds_eu.id]
}
