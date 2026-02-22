################################################################################
# CloudFront CDN Module for HustleXP API
# - CloudFront distribution with ALB + S3 origins
# - S3 bucket for static assets with OAC
# - Security response headers policy
# - Access logging to S3
# - Optional WAF association
################################################################################

locals {
  alb_origin_id    = "${var.app_name}-alb"
  s3_origin_id     = "${var.app_name}-s3-static"
  resource_prefix  = "${var.app_name}-${var.environment}"
}

# ------------------------------------------------------------------------------
# S3 Bucket: Static Assets
# ------------------------------------------------------------------------------

resource "aws_s3_bucket" "static_assets" {
  bucket = "${local.resource_prefix}-static-assets"

  tags = {
    Name        = "${local.resource_prefix}-static-assets"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_s3_bucket_versioning" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3 bucket policy granting CloudFront OAC read access
resource "aws_s3_bucket_policy" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.static_assets.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
          }
        }
      }
    ]
  })
}

# ------------------------------------------------------------------------------
# S3 Bucket: CloudFront Access Logs
# ------------------------------------------------------------------------------

resource "aws_s3_bucket" "cf_logs" {
  bucket = "${local.resource_prefix}-cf-logs"

  tags = {
    Name        = "${local.resource_prefix}-cf-logs"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_s3_bucket_ownership_controls" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "cf_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.cf_logs]
  bucket     = aws_s3_bucket.cf_logs.id
  acl        = "log-delivery-write"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    expiration {
      days = 90
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }
}

# ------------------------------------------------------------------------------
# Origin Access Control (OAC) for S3
# ------------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "s3_oac" {
  name                              = "${local.resource_prefix}-s3-oac"
  description                       = "OAC for ${local.resource_prefix} static assets bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ------------------------------------------------------------------------------
# CloudFront Cache Policies
# ------------------------------------------------------------------------------

resource "aws_cloudfront_cache_policy" "static_assets" {
  name        = "${local.resource_prefix}-static-assets-cache"
  comment     = "Cache policy for static assets with 24h TTL"
  default_ttl = 86400  # 24 hours
  max_ttl     = 604800 # 7 days
  min_ttl     = 3600   # 1 hour

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }

    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# ------------------------------------------------------------------------------
# CloudFront Origin Request Policy (for ALB pass-through)
# ------------------------------------------------------------------------------

resource "aws_cloudfront_origin_request_policy" "alb_passthrough" {
  name    = "${local.resource_prefix}-alb-passthrough"
  comment = "Forward all headers, cookies, and query strings to ALB"

  cookies_config {
    cookie_behavior = "all"
  }

  headers_config {
    header_behavior = "allViewer"
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

# ------------------------------------------------------------------------------
# CloudFront Response Headers Policy (Security Headers)
# ------------------------------------------------------------------------------

resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name    = "${local.resource_prefix}-security-headers"
  comment = "Security headers for ${local.resource_prefix}"

  security_headers_config {
    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }

    content_security_policy {
      content_security_policy = "default-src 'self'; frame-ancestors 'none'"
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=()"
      override = true
    }
  }
}

# ------------------------------------------------------------------------------
# CloudFront Distribution
# ------------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "CDN for ${local.resource_prefix}"
  default_root_object = ""
  aliases             = [var.domain_name]
  price_class         = "PriceClass_100"
  web_acl_id          = var.web_acl_id != "" ? var.web_acl_id : null

  # ---------------------------------------------------------------------------
  # Origin: ALB (API backend)
  # ---------------------------------------------------------------------------
  origin {
    domain_name = var.alb_dns_name
    origin_id   = local.alb_origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }

    custom_header {
      name  = "X-Custom-Origin-Verify"
      value = "hustlexp-cdn-${var.environment}"
    }
  }

  # ---------------------------------------------------------------------------
  # Origin: S3 (Static assets with OAC)
  # ---------------------------------------------------------------------------
  origin {
    domain_name              = aws_s3_bucket.static_assets.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.s3_oac.id
  }

  # ---------------------------------------------------------------------------
  # Default Cache Behavior: Pass-through to ALB (no caching for API calls)
  # ---------------------------------------------------------------------------
  default_cache_behavior {
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = local.alb_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

    # Use the AWS managed CachingDisabled policy for API pass-through
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id = aws_cloudfront_origin_request_policy.alb_passthrough.id
  }

  # ---------------------------------------------------------------------------
  # Ordered Cache Behavior: /static/* -> S3 with 24h cache
  # ---------------------------------------------------------------------------
  ordered_cache_behavior {
    path_pattern               = "/static/*"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.static_assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
  }

  # ---------------------------------------------------------------------------
  # Ordered Cache Behavior: /assets/* -> S3 with 24h cache
  # ---------------------------------------------------------------------------
  ordered_cache_behavior {
    path_pattern               = "/assets/*"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.static_assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
  }

  # ---------------------------------------------------------------------------
  # Custom Error Responses
  # ---------------------------------------------------------------------------
  custom_error_response {
    error_code            = 502
    error_caching_min_ttl = 10
    response_code         = 502
    response_page_path    = "/static/errors/502.html"
  }

  custom_error_response {
    error_code            = 503
    error_caching_min_ttl = 10
    response_code         = 503
    response_page_path    = "/static/errors/503.html"
  }

  # ---------------------------------------------------------------------------
  # Access Logging
  # ---------------------------------------------------------------------------
  logging_config {
    include_cookies = false
    bucket          = aws_s3_bucket.cf_logs.bucket_domain_name
    prefix          = "cloudfront/${var.environment}/"
  }

  # ---------------------------------------------------------------------------
  # TLS / SSL Configuration
  # ---------------------------------------------------------------------------
  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ---------------------------------------------------------------------------
  # Geo Restriction (none)
  # ---------------------------------------------------------------------------
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = {
    Name        = "${local.resource_prefix}-cdn"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
