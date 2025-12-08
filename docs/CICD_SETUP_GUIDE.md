# Full CI/CD Setup Guide for HustleXP AI Backend

Complete step-by-step guide to enable automated testing and deployment.

---

## Prerequisites

Before starting, ensure you have:
- [ ] GitHub repository connected (`git remote -v` to verify)
- [ ] Railway account (or Render/Cloud Run)
- [ ] All API keys from your `.env` file handy

---

## Step 1: Push Code to GitHub

If you haven't already, push your code:

```bash
cd /Users/sebastiandysart/HustleXP/hustlexp-ai-backend

# Check current status
git status

# Add all files
git add .

# Commit
git commit -m "feat: complete Seattle beta AI backend"

# Push to GitHub
git push origin main
```

---

## Step 2: Open GitHub Secrets Settings

1. Go to your GitHub repository in browser:
   - https://github.com/YOUR_USERNAME/hustlexp-ai-backend

2. Click **Settings** (top right tab)

3. In the left sidebar, scroll to **Security** section

4. Click **Secrets and variables** → **Actions**

5. You'll see a page with "Repository secrets"

---

## Step 3: Add AI Provider Secrets

Click **"New repository secret"** for each of these:

### Secret 1: OPENAI_API_KEY
```
Name:  OPENAI_API_KEY
Value: sk-proj-... (your OpenAI key from .env)
```
Click **Add secret**

### Secret 2: DEEPSEEK_API_KEY
```
Name:  DEEPSEEK_API_KEY
Value: sk-... (your DeepSeek key from .env)
```
Click **Add secret**

### Secret 3: GROQ_API_KEY
```
Name:  GROQ_API_KEY
Value: gsk_... (your Groq key from .env)
```
Click **Add secret**

---

## Step 4: Add Database Secrets

### Secret 4: DATABASE_URL
```
Name:  DATABASE_URL
Value: postgres://... (your Neon database URL from .env)
```
Click **Add secret**

### Secret 5: UPSTASH_REDIS_REST_URL
```
Name:  UPSTASH_REDIS_REST_URL
Value: https://... (your Upstash URL from .env)
```
Click **Add secret**

### Secret 6: UPSTASH_REDIS_REST_TOKEN
```
Name:  UPSTASH_REDIS_REST_TOKEN
Value: (your Upstash token from .env)
```
Click **Add secret**

---

## Step 5: Set Up Railway for Deployment

### 5a. Create Railway Account
1. Go to https://railway.app
2. Sign up with GitHub (recommended for easy connection)
3. Click **New Project**

### 5b. Connect Your Repository
1. Choose **Deploy from GitHub repo**
2. Select `hustlexp-ai-backend`
3. Railway will detect it's a Node.js app

### 5c. Add Environment Variables in Railway
1. Click on your project
2. Go to **Variables** tab
3. Click **Raw Editor** and paste your entire `.env` file
4. Click **Update Variables**

### 5d. Get Railway API Token
1. Click your profile picture (bottom left)
2. Click **Account Settings**
3. Go to **Tokens** section
4. Click **Create Token**
5. Name it: `github-actions`
6. Copy the token (starts with something like `ry_...`)

### 5e. Add Railway Token to GitHub
Back in GitHub Secrets:
```
Name:  RAILWAY_TOKEN
Value: (the token you just copied)
```
Click **Add secret**

---

## Step 6: Update Workflow URLs

Edit `.github/workflows/ci-cd.yml` to use your actual URLs:

1. Find these lines (around line 130 and 155):
```yaml
url: https://staging.hustlexp.com
url: https://api.hustlexp.com
```

2. Replace with your Railway URLs. To find them:
   - Go to Railway project
   - Click **Settings** → **Domains**
   - Your URL looks like: `https://hustlexp-ai-backend-production.up.railway.app`

3. Update the health check URLs too (lines ~180-195)

---

## Step 7: (Optional) Set Up Sentry Error Tracking

### 7a. Create Sentry Account
1. Go to https://sentry.io
2. Sign up (free tier available)
3. Create a new project → Node.js

### 7b. Get Sentry DSN
1. Go to Project Settings → Client Keys (DSN)
2. Copy the DSN URL

### 7c. Add Sentry Secrets to GitHub
```
Name:  SENTRY_DSN
Value: https://...@sentry.io/...

Name:  SENTRY_AUTH_TOKEN
Value: (from sentry.io → Settings → API Keys)
```

### 7d. Add Sentry DSN to Railway
Also add `SENTRY_DSN` to Railway environment variables.

---

## Step 8: Test the Pipeline

### Trigger a Build
```bash
# Make a small change
echo "# CI/CD Enabled" >> README.md
git add .
git commit -m "test: trigger CI/CD pipeline"
git push origin main
```

### Watch it Run
1. Go to GitHub → **Actions** tab
2. You'll see your workflow running
3. Click on it to see each step:
   - ✅ Lint & Type Check
   - ✅ Run Tests
   - ✅ Security Audit
   - ✅ Build
   - ✅ Deploy to Production
   - ✅ Health Check

---

## Step 9: Verify Deployment

### Check Railway
1. Go to Railway dashboard
2. Look for "Deploying..." or "Active"
3. Click "View Logs" to see server output

### Check Health Endpoint
```bash
curl https://your-railway-url.up.railway.app/health
```

Should return:
```json
{"status":"ok","timestamp":"..."}
```

---

## Summary: All Secrets Needed

| Secret Name | Where From | Required? |
|-------------|------------|-----------|
| `OPENAI_API_KEY` | openai.com | ✅ Yes |
| `DEEPSEEK_API_KEY` | deepseek.com | ✅ Yes |
| `GROQ_API_KEY` | groq.com | ✅ Yes |
| `DATABASE_URL` | neon.tech | ✅ Yes |
| `UPSTASH_REDIS_REST_URL` | upstash.com | ✅ Yes |
| `UPSTASH_REDIS_REST_TOKEN` | upstash.com | ✅ Yes |
| `RAILWAY_TOKEN` | railway.app | ✅ Yes |
| `SENTRY_DSN` | sentry.io | Optional |
| `SENTRY_AUTH_TOKEN` | sentry.io | Optional |

---

## Troubleshooting

### "Secret not found" error
- Check the secret name matches exactly (case-sensitive)
- Verify you added it to the correct repository

### Tests failing in CI but passing locally
- Secrets might not be set correctly
- Check the workflow logs for specific error messages

### Deployment not triggering
- Ensure you pushed to `main` branch (not a different branch)
- Check that RAILWAY_TOKEN is valid

### Health check failing
- Wait 30-60 seconds after deployment
- Verify your Railway app has all environment variables

---

## What Happens Now?

Every time you:
- **Push to `main`** → Full test + deploy to production
- **Push to `develop`** → Full test + deploy to staging  
- **Open a PR** → Tests run, no deployment

Your backend is now fully automated! 🚀
