# syntax=docker/dockerfile:1
# ==============================================================================
# Multi-stage Dockerfile for Agrawal API (Agrawal_Backend)
# Built for Node.js 24 LTS on Debian Bookworm Slim
#
# Usage (run from this directory):
#   docker build -t agrawal-api:latest .
#
# Production deployment executes:
#   IMAGE_URI=agrawal-api:latest docker compose --profile migration -f deploy/docker-compose.production.yml run --rm --no-deps migration-prod
#   docker compose -f deploy/docker-compose.production.yml up -d
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Base runtime environment
# ------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS base

WORKDIR /app
ENV NODE_ENV=production

# Install OpenSSL and CA certificates for Prisma engines and secure outbound calls
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------------------
# Stage 2: Dependencies and Build
# ------------------------------------------------------------------------------
FROM base AS builder

WORKDIR /app
ENV NODE_ENV=development

# Copy dependency manifests for layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies needed for build & prisma generate)
RUN if [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install; \
    fi

# Copy API source code, Prisma multi-file schemas, tests, and configuration
# (node_modules, dist, .env and build artifacts are excluded via .dockerignore)
COPY . .

# Generate Prisma Client
ENV DATABASE_URL="postgresql://postgres:dummy@127.0.0.1:5432/dummy?schema=public"
ENV DATABASE_MIGRATION_URL="postgresql://postgres:dummy@127.0.0.1:5432/dummy?schema=public"
RUN npm run prisma:generate

# Build TypeScript to JavaScript in dist/
RUN npm run build

# Keep Prisma CLI as a production dependency for the migration service; remove build/test tooling from the image.
RUN npm prune --omit=dev

# ------------------------------------------------------------------------------
# Stage 3: Production Runner
# ------------------------------------------------------------------------------
FROM base AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV PATH="/app/node_modules/.bin:${PATH}"

# Copy installed dependencies and package manifest
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package-lock.json* /app/

# Copy compiled application output and Prisma migration resources/configuration.
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/prisma /app/prisma
COPY --from=builder /app/prisma.config.ts* /app/
# Copy the RDS CA bundle from the build context with permissions readable by node.
COPY --chown=node:node --chmod=0644 global-bundle.pem /etc/ssl/certs/global-bundle.pem
# Drop root privileges: use built-in node user
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Deterministic container healthcheck against /healthz using Node 24 native fetch
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1));"

# Start the API server
CMD ["node", "dist/main.js"]
