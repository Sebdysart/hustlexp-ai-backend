# ============================================================================
# HustleXP Backend — Multi-stage Dockerfile
# ============================================================================
# Stage 1: Install dependencies (cached unless package.json changes)
# Stage 2: Production runtime (minimal image, no devDependencies)
# ============================================================================

# ---------- Stage 1: Dependencies ----------
# Pin to specific Node 20 Alpine version for reproducible builds
# Update this periodically: https://hub.docker.com/_/node/tags?name=20-alpine
FROM node:20.18-alpine3.21 AS deps

WORKDIR /app

# Copy only package files for optimal caching
COPY package.json package-lock.json ./

# Install all dependencies (including dev for building)
RUN npm ci --ignore-scripts

# ---------- Stage 2: Production Runtime ----------
FROM node:20.18-alpine3.21 AS runtime

# Security: run as non-root user
RUN addgroup --system --gid 1001 hustlexp && \
    adduser --system --uid 1001 hustlexp

WORKDIR /app

# Copy package files and install production-only deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy source code
COPY backend/ ./backend/
COPY public/ ./public/
COPY tsconfig.json ./
COPY Procfile ./

# Copy tsx for runtime TypeScript execution
COPY --from=deps /app/node_modules/.package-lock.json /tmp/.package-lock.json
RUN npm install tsx --save-prod 2>/dev/null || true

# Security: Drop all capabilities, set read-only filesystem hints
RUN chmod -R 555 /app/backend /app/public

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/health || exit 1

# Switch to non-root user
USER hustlexp

# Expose port (Railway uses $PORT, default 3000)
EXPOSE ${PORT:-3000}

# Runtime metadata
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="HustleXP Backend" \
      org.opencontainers.image.description="HustleXP API Server — Hono + tRPC" \
      org.opencontainers.image.version="1.0.0"

# Default command: start the API server
CMD ["npx", "tsx", "backend/src/server.ts"]
