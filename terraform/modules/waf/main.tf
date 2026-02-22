###############################################################################
# AWS WAFv2 Web ACL - HustleXP API Protection
#
# Provides layered security for the API behind an ALB:
#   1. AWS Managed Rules (common threats, SQLi, known-bad inputs)
#   2. Rate limiting per source IP
#   3. Optional geo-blocking
#   4. Custom suspicious user-agent blocking
###############################################################################

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  name_prefix = "${var.app_name}-${var.environment}"

  default_tags = merge(
    {
      Application = var.app_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Module      = "waf"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# Web ACL
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "this" {
  name        = "${local.name_prefix}-waf"
  description = "WAF Web ACL protecting the ${var.app_name} API (${var.environment})"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # ---------------------------------------------------------------------------
  # Rule 1 - AWS Managed Rules: Common Rule Set
  # ---------------------------------------------------------------------------
  rule {
    name     = "aws-managed-common-rules"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-common-rules"
      sampled_requests_enabled   = true
    }
  }

  # ---------------------------------------------------------------------------
  # Rule 2 - AWS Managed Rules: SQL Injection
  # ---------------------------------------------------------------------------
  rule {
    name     = "aws-managed-sqli-rules"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-sqli-rules"
      sampled_requests_enabled   = true
    }
  }

  # ---------------------------------------------------------------------------
  # Rule 3 - AWS Managed Rules: Known Bad Inputs
  # ---------------------------------------------------------------------------
  rule {
    name     = "aws-managed-known-bad-inputs"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # ---------------------------------------------------------------------------
  # Rule 4 - Rate Limiting (per source IP)
  # ---------------------------------------------------------------------------
  rule {
    name     = "rate-limit-per-ip"
    priority = 40

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.rate_limit
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # ---------------------------------------------------------------------------
  # Rule 5 - Geo-Blocking (conditional on var.blocked_countries)
  # ---------------------------------------------------------------------------
  dynamic "rule" {
    for_each = length(var.blocked_countries) > 0 ? [1] : []

    content {
      name     = "geo-block"
      priority = 50

      action {
        block {}
      }

      statement {
        geo_match_statement {
          country_codes = var.blocked_countries
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.name_prefix}-geo-block"
        sampled_requests_enabled   = true
      }
    }
  }

  # ---------------------------------------------------------------------------
  # Rule 6 - Block Suspicious User-Agent Strings
  #
  # Uses a regex pattern set to match known scanner / attack tool signatures
  # in the User-Agent header.
  # ---------------------------------------------------------------------------
  rule {
    name     = "block-suspicious-user-agents"
    priority = 60

    action {
      block {}
    }

    statement {
      regex_pattern_set_reference_statement {
        arn = aws_wafv2_regex_pattern_set.suspicious_user_agents.arn

        field_to_match {
          single_header {
            name = "user-agent"
          }
        }

        text_transformation {
          priority = 0
          type     = "NONE"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-suspicious-ua"
      sampled_requests_enabled   = true
    }
  }

  # ---------------------------------------------------------------------------
  # Top-level visibility config (Web ACL default metrics)
  # ---------------------------------------------------------------------------
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-waf"
    sampled_requests_enabled   = true
  }

  tags = local.default_tags
}

# -----------------------------------------------------------------------------
# Regex Pattern Set - Suspicious User-Agent strings
# -----------------------------------------------------------------------------

resource "aws_wafv2_regex_pattern_set" "suspicious_user_agents" {
  name        = "${local.name_prefix}-suspicious-user-agents"
  description = "Regex patterns matching known scanner and attack tool user-agent strings"
  scope       = "REGIONAL"

  dynamic "regular_expression" {
    for_each = var.suspicious_user_agents
    content {
      regex_string = regular_expression.value
    }
  }

  tags = local.default_tags
}

# -----------------------------------------------------------------------------
# WAF <-> ALB Association
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

# -----------------------------------------------------------------------------
# CloudWatch Logging (optional but recommended)
#
# WAF logs are sent to a CloudWatch log group. The log group name must begin
# with "aws-waf-logs-" per AWS requirements.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${local.name_prefix}"
  retention_in_days = 30

  tags = local.default_tags
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  resource_arn            = aws_wafv2_web_acl.this.arn

  # Redact the Authorization header from logs to avoid leaking tokens
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
}
