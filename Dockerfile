# HustleXP backend production image

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS builder
WORKDIR /app

ARG HX_BUILD_REVISION=""
ARG HX_BUILD_SOURCE_CLEAN=""
ARG HX_BUILD_TIMESTAMP=""
ARG RAILWAY_GIT_COMMIT_SHA=""
ARG GITHUB_SHA=""
ARG SOURCE_VERSION=""
ENV HX_BUILD_ENVIRONMENT=production \
    HX_BUILD_REVISION=$HX_BUILD_REVISION \
    HX_BUILD_SOURCE_CLEAN=$HX_BUILD_SOURCE_CLEAN \
    HX_BUILD_TIMESTAMP=$HX_BUILD_TIMESTAMP \
    RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA \
    GITHUB_SHA=$GITHUB_SHA \
    SOURCE_VERSION=$SOURCE_VERSION

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run compile

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 hustlexp

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/Procfile ./Procfile
COPY --from=builder /app/backend/database/constitutional-schema.sql ./backend/database/constitutional-schema.sql
COPY --from=builder /app/backend/database/migrations ./backend/database/migrations

RUN chown -R hustlexp:nodejs /app
USER hustlexp

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
