# ==============================================================================
# Route 53 DNS Records (Hosted Domain)
#
# References:
#   - Issue #2 (Provision AWS environment and hosted domain)
#   - Issue #13 (Operator inputs owed: Domain name)
#   - ADR-0026 & ADR-0028 (Hosted domain surfaces: apex, register, api)
#
# Web hostnames go through CloudFront; the API host goes straight to Caddy.
#
# Provisions DNS records if var.route53_zone_id is supplied by operator.
# ==============================================================================

# Web hostnames (apex, www, register) -> CloudFront. Production only; see
# local.web_hosts.
resource "aws_route53_record" "web" {
  for_each = var.route53_zone_id != "" ? local.web_hosts : {}
  zone_id  = var.route53_zone_id
  name     = each.value
  type     = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

moved {
  from = aws_route53_record.apex[0]
  to   = aws_route53_record.web["apex"]
}

moved {
  from = aws_route53_record.www[0]
  to   = aws_route53_record.web["www"]
}

moved {
  from = aws_route53_record.register[0]
  to   = aws_route53_record.web["register"]
}

# API host (api.<domain> or staging-api.<domain>) -> EC2 Elastic IP. This is the
# only ingress path for the API: Caddy obtains and serves its certificate.
resource "aws_route53_record" "api" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = local.api_host
  type    = "A"
  ttl     = 300
  records = [aws_eip.api_eip.public_ip]
}
