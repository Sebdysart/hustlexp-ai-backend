# HustleXP Production Infrastructure
# Multi-region deployment on AWS ECS Fargate

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket = "hustlexp-terraform-state"
    key    = "prod/terraform.tfstate"
    region = "us-east-1"
  }
}

# Primary region: us-east-1
provider "aws" {
  region = "us-east-1"
  alias  = "primary"
}

# Secondary region: us-west-2 (for DR)
provider "aws" {
  region = "us-west-2"
  alias  = "secondary"
}

locals {
  app_name    = "hustlexp-api"
  environment = "prod"
  
  # Common tags
  tags = {
    Environment = local.environment
    Project     = "HustleXP"
    ManagedBy   = "Terraform"
  }
}

# VPC Module (Primary)
module "vpc_primary" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  
  providers = {
    aws = aws.primary
  }

  name = "${local.app_name}-vpc-primary"
  cidr = "10.0.0.0/16"

  azs             = ["us-east-1a", "us-east-1b", "us-east-1c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = false
  enable_vpn_gateway = false

  tags = local.tags
}

# VPC Module (Secondary)
module "vpc_secondary" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  
  providers = {
    aws = aws.secondary
  }

  name = "${local.app_name}-vpc-secondary"
  cidr = "10.1.0.0/16"

  azs             = ["us-west-2a", "us-west-2b", "us-west-2c"]
  private_subnets = ["10.1.1.0/24", "10.1.2.0/24", "10.1.3.0/24"]
  public_subnets  = ["10.1.101.0/24", "10.1.102.0/24", "10.1.103.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = false
  enable_vpn_gateway = false

  tags = local.tags
}

# Application Load Balancer (Primary)
resource "aws_lb" "primary" {
  provider = aws.primary

  name               = "${local.app_name}-alb-primary"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_primary.id]
  subnets            = module.vpc_primary.public_subnets

  enable_deletion_protection = true

  tags = local.tags
}

# ALB Security Group (Primary)
resource "aws_security_group" "alb_primary" {
  provider = aws.primary

  name_prefix = "${local.app_name}-alb-"
  vpc_id      = module.vpc_primary.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# Target Group (Primary)
resource "aws_lb_target_group" "primary" {
  provider = aws.primary

  name     = "${local.app_name}-tg-primary"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = module.vpc_primary.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 3
  }

  tags = local.tags
}

# ALB Listener (Primary)
resource "aws_lb_listener" "primary" {
  provider = aws.primary

  load_balancer_arn = aws_lb.primary.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.primary.arn
  }
}

# ECS Security Group (Primary)
resource "aws_security_group" "ecs_primary" {
  provider = aws.primary

  name_prefix = "${local.app_name}-ecs-"
  vpc_id      = module.vpc_primary.vpc_id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_primary.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# IAM Role for ECS Execution
resource "aws_iam_role" "ecs_execution" {
  provider = aws.primary

  name = "${local.app_name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  provider = aws.primary

  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ECS Module (Primary)
module "ecs_primary" {
  source = "../../modules/ecs"
  
  providers = {
    aws = aws.primary
  }

  app_name     = local.app_name
  cluster_name = "${local.app_name}-cluster-primary"
  aws_region   = "us-east-1"

  image_uri     = var.image_uri
  cpu           = 1024
  memory        = 2048
  desired_count = 3
  min_capacity  = 3
  max_capacity  = 20

  subnet_ids         = module.vpc_primary.private_subnets
  security_group_id  = aws_security_group.ecs_primary.id
  target_group_arn   = aws_lb_target_group.primary.arn
  load_balancer_listener = aws_lb_listener.primary
  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_execution.arn

  environment_variables = {
    NODE_ENV            = "production"
    PORT                = "3000"
    ALLOWED_ORIGINS     = "https://app.hustlexp.com,https://admin.hustlexp.com"
    FIREBASE_PROJECT_ID = var.firebase_project_id
  }

  secrets = {
    DATABASE_URL           = var.database_url_arn
    UPSTASH_REDIS_URL      = var.redis_url_arn
    STRIPE_SECRET_KEY      = var.stripe_secret_key_arn
    FIREBASE_PRIVATE_KEY   = var.firebase_private_key_arn
  }
}

# WAF Module (AUDIT FIX: DDoS, SQLi, XSS protection)
module "waf" {
  source = "../../modules/waf"

  providers = {
    aws = aws.primary
  }

  app_name    = local.app_name
  environment = local.environment
  alb_arn     = aws_lb.primary.arn
  rate_limit  = 2000

  tags = local.tags
}

# CDN Module (AUDIT FIX: CloudFront for static assets + API caching)
module "cdn" {
  source = "../../modules/cdn"

  providers = {
    aws = aws.primary
  }

  app_name            = local.app_name
  environment         = local.environment
  alb_dns_name        = aws_lb.primary.dns_name
  domain_name         = "api.hustlexp.com"
  acm_certificate_arn = var.acm_certificate_arn
  web_acl_id          = module.waf.web_acl_arn
}

# Route 53 DNS (Multi-region failover)
resource "aws_route53_record" "primary" {
  zone_id = var.route53_zone_id
  name    = "api.hustlexp.com"
  type    = "A"

  failover_routing_policy {
    type = "PRIMARY"
  }

  alias {
    name                   = aws_lb.primary.dns_name
    zone_id                = aws_lb.primary.zone_id
    evaluate_target_health = true
  }

  health_check_id = aws_route53_health_check.primary.id
  set_identifier  = "primary"
}

resource "aws_route53_health_check" "primary" {
  fqdn              = "api.hustlexp.com"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30

  tags = local.tags
}
