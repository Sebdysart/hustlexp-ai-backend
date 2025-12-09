# Gate 9: Secrets — Verification Bundle

---

# ITEM 9.1: Environment Variables Set

## 9.1.1 Required Variables Checklist

| Variable | Format | Staging | Prod | Verified |
|----------|--------|---------|------|----------|
| `STRIPE_SECRET_KEY` | `sk_test_...` or `sk_live_...` | ⬜ | ⬜ | |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | ⬜ | ⬜ | |
| `DATABASE_URL` | `postgres://...` | ⬜ | ⬜ | |
| `CLOUDFLARE_ACCOUNT_ID` | Non-empty | ⬜ | ⬜ | |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | Non-empty | ⬜ | ⬜ | |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | Non-empty | ⬜ | ⬜ | |
| `CLOUDFLARE_R2_BUCKET_NAME` | Non-empty | ⬜ | ⬜ | |
| `OPENAI_API_KEY` | `sk-...` | ⬜ | ⬜ | |
| `DEEPSEEK_API_KEY` | Non-empty | ⬜ | ⬜ | |
| `GROQ_API_KEY` | `gsk_...` | ⬜ | ⬜ | |
| `FIREBASE_PROJECT_ID` | Non-empty | ⬜ | ⬜ | |
| `FIREBASE_CLIENT_EMAIL` | Email format | ⬜ | ⬜ | |
| `FIREBASE_PRIVATE_KEY` | `-----BEGIN...` | ⬜ | ⬜ | |
| `UPSTASH_REDIS_REST_URL` | URL | ⬜ | ⬜ | |
| `UPSTASH_REDIS_REST_TOKEN` | Non-empty | ⬜ | ⬜ | |

## 9.1.2 Verification Method

**Railway:**
```bash
# View env vars in Railway dashboard
# Settings → Variables
# Screenshot required
```

**Local:**
```bash
# Check .env exists and has all vars
cat .env | grep -E "^[A-Z]" | cut -d= -f1
```

---

# ITEM 9.2: No Secrets in Git

## 9.2.1 Scan Git History

```bash
cd /Users/sebastiandysart/HustleXP/hustlexp-ai-backend

# Search for Stripe keys
git log --all -p | grep -E "(sk_live_|sk_test_|whsec_)" | head -20

# Search for API keys
git log --all -p | grep -E "(OPENAI_API_KEY|DEEPSEEK_API_KEY|GROQ_API_KEY)=" | head -20

# Search for database URLs
git log --all -p | grep -E "postgres://.*:.*@" | head -20
```

**Expected (PASS):** Empty output (no matches)

**FAIL if:** Any secrets found in history

## 9.2.2 Check .gitignore

```bash
cat .gitignore | grep -E "(\.env|secrets)"
```

**Expected:** `.env` and related files are listed

## 9.2.3 Check Current Files

```bash
# Ensure no hardcoded secrets in source
grep -r "sk_live_" src/
grep -r "sk_test_" src/
grep -r "whsec_" src/
```

**Expected:** Empty output

---

## Evidence Checklist

| Test | Status | Verified By | Date |
|------|--------|-------------|------|
| 9.1.1 Staging vars | ⬜ | | |
| 9.1.1 Prod vars | ⬜ | | |
| 9.2.1 Git history clean | ⬜ | | |
| 9.2.2 .gitignore correct | ⬜ | | |
| 9.2.3 No hardcoded secrets | ⬜ | | |

**Gate 9: 5 tests | Status:** ⬜

**Screenshot Required:**
- [ ] Railway Staging env vars (redacted)
- [ ] Railway Prod env vars (redacted)

---

*Bundle version: 1.0*
