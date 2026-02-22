variable "image_uri" {
  description = "Docker image URI for the application"
  type        = string
}

variable "firebase_project_id" {
  description = "Firebase project ID"
  type        = string
}

variable "database_url_arn" {
  description = "ARN of the Secrets Manager secret for DATABASE_URL"
  type        = string
}

variable "redis_url_arn" {
  description = "ARN of the Secrets Manager secret for Redis URL"
  type        = string
}

variable "stripe_secret_key_arn" {
  description = "ARN of the Secrets Manager secret for Stripe API key"
  type        = string
}

variable "firebase_private_key_arn" {
  description = "ARN of the Secrets Manager secret for Firebase private key"
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ARN of the ACM certificate for CloudFront (must be in us-east-1)"
  type        = string
}
