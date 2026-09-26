# ==============================================================================
# Per-environment hostnames and origins
#
# Every file derives environment-specific names from here so staging and
# production never disagree about which host serves what.
# ==============================================================================

locals {
  is_production = var.environment == "production"

  # Caddy on the EC2 host terminates TLS for exactly these names (deploy/Caddyfile).
  api_host = local.is_production ? "api.${var.domain_name}" : "staging-api.${var.domain_name}"

  # Public web hostnames served by CloudFront. CloudFront aliases and Route 53
  # names are global, so only production claims them; a staging stack serves
  # its web client from the distribution's *.cloudfront.net domain.
  web_hosts = local.is_production ? {
    apex     = var.domain_name
    www      = "www.${var.domain_name}"
    register = "register.${var.domain_name}"
  } : {}

  use_acm_certificate = var.acm_certificate_arn != "" && length(local.web_hosts) > 0

  # Browser origins allowed through CORS and CSRF. The first entry is also the
  # base URL the API puts in invite links (src/main.ts webBaseUrl); values()
  # orders by key, so production leads with the apex.
  web_origins = concat(
    local.is_production
    ? [for host in values(local.web_hosts) : "https://${host}"]
    : ["https://${aws_cloudfront_distribution.main.domain_name}"],
    ["https://${local.api_host}"],
  )
}
