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

  # Browser origins allowed through CORS and CSRF. The first entry is also the
  # base URL the API puts in invite links (src/main.ts webBaseUrl).
  web_origins = concat(
    local.is_production
    ? ["https://${var.domain_name}", "https://register.${var.domain_name}"]
    : ["https://${aws_cloudfront_distribution.main.domain_name}"],
    ["https://${local.api_host}"],
  )
}
