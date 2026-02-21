# HustleXP Production Hardening Guide

**Version:** 1.0.0  
**Last Updated:** February 2026  
**Status:** CRITICAL - Apply before production deployment

---

## 🚨 Executive Summary

This document details the critical production hardening changes made to address the 52/100 readiness score identified in the February 2026 audit.

### Critical Fixes Applied

| Priority | Issue | Fix | Status |
|----------|-------|-----|--------|
| P0 | No compiled Procfile | Created `Procfile` with `node dist/` | ✅ |
| P0 | CORS wildcard in production | Added fail-fast validation | ✅ |
| P0 | No AI cost governor | Built `AIRouter` with budget caps | ✅ |
| P0 | Migration directory chaos | Consolidation script + validator | ✅ |
| P0 | No rate limiting on AI | Added per-user rate limits | ✅ |

---

## 📋 Quick Start

### 1. Verify Configuration

```bash
# Check required environment variables
node -e "require('./backend/src/config').validateConfig()"
```

Required for production:
- `DATABASE_URL`
- `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`
- `STRIPE_SECRET_KEY` (not placeholder)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `UPSTASH_REDIS_URL` (for BullMQ)
- `ALLOWED_ORIGINS` (comma-separated, NO wildcards)

### 2. Build for Production

```bash
# Clean build
npm ci
npm run build

# Verify dist/ exists
ls dist/backend/src/server.js
```

### 3. Validate Schema

```bash
# Check database schema
npm run db:validate

# Expected output: "✅ Schema validation passed"
```

### 4. Deploy

```bash
# Using Railway (configured in Procfile)
railway up

# Or manually
NODE_ENV=production node dist/backend/src/server.js
```

---

## 🔧 Detailed Changes

### 1. Production Procfile

**File:** `Procfile`

```
web: node dist/backend/src/server.js
worker: node dist/backend/src/jobs/workers.js
release: npm run db:migrate
```

**Why:** Running `tsx` in production is 3x slower and uses 40% more memory.

---

### 2. AI Cost Governor

**File:** `backend/src/ai/AIRouter.ts`

**Budget Allocation:**

| Agent | Daily Budget | Max Tokens | Fallback Chain |
|-------|-------------|------------|----------------|
| judge | $0.50 | 4,000 | groq → openai → deepseek |
| matchmaker | $0.10 | 2,000 | groq → openai |
| dispute | $1.00 | 8,000 | openai → deepseek → groq |
| reputation | $0.05 | 1,500 | groq → deepseek |
| onboarding | $0.05 | 1,000 | groq → openai |
| moderation | $0.10 | 2,000 | groq → openai |

**Usage:**
```typescript
import { callAI } from './ai/AIRouter';
const result = await callAI('matchmaker', userId, prompt);
```

**Error Codes:**
- `HX701`: AI daily budget exceeded
- `HX702`: All AI providers exhausted
- `HX001`: Redis not configured

---

### 3. Rate Limiting

**File:** `backend/src/ai/rateLimit.ts`

**Limits:**

| Agent | Requests | Window |
|-------|----------|--------|
| judge | 10 | 1 minute |
| matchmaker | 30 | 1 minute |
| dispute | 5 | 1 minute |
| reputation | 20 | 1 minute |
| onboarding | 5 | 1 hour |
| moderation | 50 | 1 minute |

**Error Code:** `HX703` (rate limit exceeded)

---

### 4. CORS Fail-Fast

**File:** `backend/src/server.ts`

Server exits on startup if:
- `ALLOWED_ORIGINS` is empty in production
- `ALLOWED_ORIGINS` contains "*"
- Any origin is not HTTPS

---

### 5. Schema Validation

**File:** `scripts/validate-schema.ts`

```bash
npm run db:validate       # Verify schema integrity
npm run db:migrate:consolidate  # Fix migration chaos
```

**Checks:**
- Critical tables exist
- Financial triggers active
- Schema hash matches expected (if set)

---

## 🧪 Testing

### Pre-Deployment Checklist

```bash
npm run build
npm test
npm run test:invariants
npm run db:validate
npm audit --audit-level=high
```

---

## 📊 Monitoring

### AI Cost Monitoring

```sql
-- Daily spend by agent
SELECT 
  agent_type,
  SUM(estimated_cost_cents) / 100.0 as cost_usd,
  COUNT(*) as requests
FROM ai_cost_logs
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY agent_type;
```

---

## 🔐 Security Checklist

- [ ] `NODE_ENV=production` set
- [ ] `ALLOWED_ORIGINS` set (no wildcards, HTTPS only)
- [ ] All API keys are production keys
- [ ] Database credentials use least-privilege
- [ ] Stripe webhook secrets rotated

---

## 🚨 Emergency Procedures

### AI Budget Exceeded (HX701)

```bash
# Check current spend
redis-cli GET "ai:budget:judge:global:$(date +%Y-%m-%d)"
```

### Database Connection Issues

```bash
# Check connection pool
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity;"
```

---

**END OF DOCUMENT**
