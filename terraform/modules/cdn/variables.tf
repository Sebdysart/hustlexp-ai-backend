variable "app_name" {
  description = "Application name used for resource naming and tagging"
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g., dev, staging, production)"
  type        = string
}

variable "alb_dns_name" {
  description = "DNS name of the Application Load Balancer origin"
  type        = string
}

variable "domain_name" {
  description = "Custom domain name for the CloudFront distribution (e.g., api.hustlexp.com)"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ARN of the ACM certificate for the custom domain (must be in us-east-1)"
  type        = string
}

variable "web_acl_id" {
  description = "ARN of the WAF Web ACL to associate with the distribution (optional)"
  type        = string
  default     = ""
}
