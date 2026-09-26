# ==============================================================================
# CloudFront Distribution and Edge Security
#
# References:
#   - ADR-0017 (CloudFront in front of EC2 and S3)
#   - ADR-0028 (Web deployment on AWS: S3 web assets behind CloudFront)
# ==============================================================================

# CloudFront Origin Access Control for S3 static web bucket
resource "aws_cloudfront_origin_access_control" "web_oac" {
  name                              = "agrawal-${var.environment}-web-oac"
  description                       = "OAC for Agrawal Samaj web static assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

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
  comment             = "Agrawal Samaj web distribution (${var.environment})"
  price_class         = "PriceClass_200" # Includes India (ap-south-1), Asia, Europe, North America
  default_root_object = "index.html"

  # Web hostnames only. The API is not behind CloudFront: api.<domain> and
  # staging-api.<domain> resolve straight to the EC2 Elastic IP, where Caddy
  # holds their certificates (dns.tf, deploy/Caddyfile).
  aliases = local.use_acm_certificate ? values(local.web_hosts) : []

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "S3-Web-Frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.web_oac.id
  }

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
    cloudfront_default_certificate = !local.use_acm_certificate
    acm_certificate_arn            = local.use_acm_certificate ? var.acm_certificate_arn : null
    ssl_support_method             = local.use_acm_certificate ? "sni-only" : null
    minimum_protocol_version       = local.use_acm_certificate ? "TLSv1.2_2021" : null
  }

  tags = {
    Name = "agrawal-${var.environment}-cf-dist"
  }
}
