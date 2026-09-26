# ==============================================================================
# Route 53 DNS Records (Hosted Domain)
#
# References:
#   - Issue #2 (Provision AWS environment and hosted domain)
#   - Issue #13 (Operator inputs owed: Domain name)
#   - ADR-0026 & ADR-0028 (Hosted domain surfaces: apex, register, api)
#
# Provisions DNS records if var.route53_zone_id is supplied by operator.
# ==============================================================================

# Apex domain (e.g. agrawal.app) -> CloudFront
resource "aws_route53_record" "apex" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# WWW subdomain -> CloudFront
resource "aws_route53_record" "www" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# Registration Portal (register.<domain>) -> CloudFront
resource "aws_route53_record" "register" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "register.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# API Subdomain (api.<domain> or staging-api.<domain>) -> EC2 Elastic IP
resource "aws_route53_record" "api" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.environment == "staging" ? "staging-api.${var.domain_name}" : "api.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.api_eip.public_ip]
}
