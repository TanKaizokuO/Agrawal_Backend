# ==============================================================================
# CloudFront Distribution and Edge Security
#
# References:
#   - ADR-0017 (CloudFront in front of EC2 and S3)
#   - ADR-0028 (Unified AWS hosting: S3 web assets + EC2 API behind CloudFront)
# ==============================================================================

# CloudFront Origin Access Control for S3 static web bucket
resource "aws_cloudfront_origin_access_control" "web_oac" {
  name                              = "agrawal-${var.environment}-web-oac"
  description                       = "OAC for Agrawal Samaj web static assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Managed Cache Policy IDs (AWS Managed)
# CachingOptimized: 658327ea-f89d-4fab-a63d-7e88639e58f6
# CachingDisabled:  4135ea2d-6df8-44a3-9e34-46e3a5bc6ab0
# AllViewerExceptHostHeader (Origin Request): b680b3d7-99d0-4203-919a-964214e4b531

resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name    = "agrawal-${var.environment}-security-headers"
  comment = "Security headers for Agrawal Samaj web and API surfaces"

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
  }
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Agrawal Samaj CloudFront distribution (${var.environment})"
  price_class         = "PriceClass_200" # Includes India (ap-south-1), Asia, Europe, North America
  default_root_object = "index.html"

  # Optional domain aliases if ACM certificate is provided
  aliases = var.acm_certificate_arn != "" ? [
    var.domain_name,
    "www.${var.domain_name}",
    "register.${var.domain_name}",
    "api.${var.domain_name}"
  ] : []

  # Origin 1: Static Web Frontend (S3)
  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "S3-Web-Frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.web_oac.id
  }

  # Origin 2: API Backend (EC2 via Elastic IP / Caddy)
  origin {
    domain_name = aws_eip.api_eip.public_dns != "" ? aws_eip.api_eip.public_dns : aws_eip.api_eip.public_ip
    origin_id   = "EC2-API-Backend"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default Cache Behavior: Static Web Assets from S3
  default_cache_behavior {
    target_origin_id       = "S3-Web-Frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]

    # AWS Managed CachingOptimized policy
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
    compress                   = true
  }

  # Ordered Cache Behavior 1: API requests routed to EC2
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "EC2-API-Backend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    # AWS Managed CachingDisabled policy
    cache_policy_id = "4135ea2d-6df8-44a3-9e34-46e3a5bc6ab0"
    # AWS Managed AllViewerExceptHostHeader origin request policy
    origin_request_policy_id   = "b680b3d7-99d0-4203-919a-964214e4b531"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
    compress                   = true
  }

  # Ordered Cache Behavior 2: Healthz probe
  ordered_cache_behavior {
    path_pattern           = "/healthz"
    target_origin_id       = "EC2-API-Backend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id = "4135ea2d-6df8-44a3-9e34-46e3a5bc6ab0"
    compress        = false
  }

  # Ordered Cache Behavior 3: Readyz probe
  ordered_cache_behavior {
    path_pattern           = "/readyz"
    target_origin_id       = "EC2-API-Backend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id = "4135ea2d-6df8-44a3-9e34-46e3a5bc6ab0"
    compress        = false
  }

  # Custom Error Response for SPA routing (React Router fallback)
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == "" ? true : false
    acm_certificate_arn            = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null
    ssl_support_method             = var.acm_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = var.acm_certificate_arn != "" ? "TLSv1.2_2021" : null
  }

  tags = {
    Name = "agrawal-${var.environment}-cf-dist"
  }
}
