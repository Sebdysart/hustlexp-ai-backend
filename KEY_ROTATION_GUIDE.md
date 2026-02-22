# HustleXP Key Rotation Guide -- CRITICAL SECURITY INCIDENT

**Date created:** 2026-02-21
**Reason:** The `.env` file was committed to a public GitHub repository, exposing ALL secrets.
**Priority:** IMMEDIATE -- Assume all credentials are compromised.

---

## Pre-Rotation Steps

### 1. Check if the GitHub repo is public or private

```bash
# Using GitHub CLI
gh repo view sebastiandysart/hustlexp-ai-backend --json visibility -q '.visibility'

# Or via the GitHub API
curl -s https://api.github.com/repos/sebastiandysart/hustlexp-ai-backend | grep '"private"'
```

If the output says `public` or `"private": false`, the credentials are exposed to the entire internet. Even if the repo is private, any collaborator or anyone who forked it before you changed visibility has access.

**Immediate action:** Make the repo private NOW if it is public.

```bash
gh repo edit sebastiandysart/hustlexp-ai-backend --visibility private
```

### 2. Remove `.env` from Git History

The `.env` file must be purged from the entire git history, not just deleted in a new commit. Old commits still contain the file.

#### Option A: BFG Repo-Cleaner (recommended -- simpler)

```bash
# Install BFG
brew install bfg

# Clone a fresh mirror of the repo
cd /tmp
git clone --mirror https://github.com/sebastiandysart/hustlexp-ai-backend.git

# Remove .env from all history
bfg --delete-files .env hustlexp-ai-backend.git

# Clean up and push
cd hustlexp-ai-backend.git
git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push
```

#### Option B: git filter-repo (more powerful)

```bash
# Install git-filter-repo
brew install git-filter-repo

# Clone the repo fresh (filter-repo requires a fresh clone)
cd /tmp
git clone https://github.com/sebastiandysart/hustlexp-ai-backend.git
cd hustlexp-ai-backend

# Remove .env from all history
git filter-repo --invert-paths --path .env

# Re-add the remote and force push
git remote add origin https://github.com/sebastiandysart/hustlexp-ai-backend.git
git push origin --force --all
git push origin --force --tags
```

#### Post-Cleanup

```bash
# Verify .env is gone from history
git log --all --full-history -- .env
# Should return nothing

# Add .env to .gitignore if not already there
echo ".env" >> .gitignore
git add .gitignore
git commit -m "Ensure .env is in .gitignore"
git push
```

**Important:** After rewriting history, all collaborators must re-clone the repository. Their local copies still reference old commits.

---

## Credential Rotation Checklist

Use this checklist to track progress. Mark each item as you complete it.

```
[ ] 1.  OpenAI API Key
[ ] 2.  DeepSeek API Key
[ ] 3.  Groq API Key
[ ] 4.  Alibaba/Qwen API Key
[ ] 5.  Neon PostgreSQL Database (primary -- neondb)
[ ] 6.  Neon PostgreSQL Database (secondary -- hxp_m4_runner)
[ ] 7.  Upstash Redis URL and Token
[ ] 8.  Firebase Web API Key
[ ] 9.  Firebase Service Account Private Key
[ ] 10. Stripe Keys (verify placeholder status)
[ ] 11. Twilio Verify Service SID
[ ] 12. IVS Webhook Secret
[ ] 13. Git history cleaned
[ ] 14. .env added to .gitignore
[ ] 15. All collaborators notified to re-clone
[ ] 16. Application redeployed with new credentials
[ ] 17. Monitoring confirmed -- no unauthorized usage
```

---

## 1. OpenAI API Key

**Exposed value:** `sk-proj-GMw56gEzPUjaWj_9BpKR...` (project-scoped key)

### Dashboard URL
<https://platform.openai.com/api-keys>

### Steps to Rotate

1. Go to <https://platform.openai.com/api-keys>.
2. Find the key starting with `sk-proj-GMw56gE...` in the list.
3. Click the **trash icon** next to it to **revoke** it immediately. This instantly blocks all usage.
4. Click **"+ Create new secret key"**.
5. Give it a descriptive name, e.g., `hustlexp-backend-prod-2026-02`.
6. Select the same project scope if applicable.
7. Copy the new key -- it will only be shown once.

### Update `.env`

```
OPENAI_API_KEY=sk-proj-<your-new-key-here>
```

### Code Changes
None expected. The app reads from the environment variable.

### Verification

```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer sk-proj-<your-new-key>" \
  -s | head -20
```

A successful response listing models confirms the new key works.

### Check for Unauthorized Usage
Visit <https://platform.openai.com/usage> and review recent activity for any requests you did not make.

---

## 2. DeepSeek API Key

**Exposed value:** `sk-3f02411c3bc74da6a44591aa0e561521`

### Dashboard URL
<https://platform.deepseek.com/api_keys>

### Steps to Rotate

1. Go to <https://platform.deepseek.com/api_keys>.
2. Log in to your DeepSeek account.
3. Locate the compromised key in the list.
4. Click **Delete** or **Revoke** next to it.
5. Click **Create new API Key**.
6. Copy the new key immediately.

### Update `.env`

```
DEEPSEEK_API_KEY=sk-<your-new-deepseek-key>
```

### Code Changes
None expected.

### Verification

```bash
curl https://api.deepseek.com/v1/models \
  -H "Authorization: Bearer sk-<your-new-key>" \
  -s | head -20
```

### Check for Unauthorized Usage
Review your DeepSeek usage dashboard for unexpected API calls.

---

## 3. Groq API Key

**Exposed value:** `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`

### Dashboard URL
<https://console.groq.com/keys>

### Steps to Rotate

1. Go to <https://console.groq.com/keys>.
2. Find the compromised key.
3. Click the **Delete** button to revoke it.
4. Click **"Create API Key"**.
5. Name it, e.g., `hustlexp-prod-2026-02`.
6. Copy the new key.

### Update `.env`

```
GROQ_API_KEY=gsk_<your-new-groq-key>
```

### Code Changes
None expected.

### Verification

```bash
curl https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer gsk_<your-new-key>" \
  -s | head -20
```

---

## 4. Alibaba/Qwen API Key

**Exposed value:** `sk-87326e871fa24567b63c9a3f11be7ba0`

### Dashboard URL
<https://dashscope.console.aliyun.com/apiKey>

### Steps to Rotate

1. Go to <https://dashscope.console.aliyun.com/apiKey> (Alibaba Cloud DashScope console).
2. Log in with your Alibaba Cloud account.
3. Find the compromised API key in the list.
4. Click **Delete** to revoke it.
5. Click **Create new API Key**.
6. Copy the new key.

### Update `.env`

```
ALIBABA_API_KEY=sk-<your-new-alibaba-key>
```

### Code Changes
None expected.

### Verification

```bash
curl https://dashscope.aliyuncs.com/compatible-mode/v1/models \
  -H "Authorization: Bearer sk-<your-new-key>" \
  -s | head -20
```

---

## 5. Neon PostgreSQL -- Primary Database (neondb)

**Exposed value:** Full connection string including password `npg_jsckB8AHbJa5` for user `neondb_owner` on endpoint `ep-young-shape-af9wgdv0`.

### Dashboard URL
<https://console.neon.tech/app/projects>

### Steps to Rotate

1. Go to <https://console.neon.tech/app/projects>.
2. Click on the project that contains `ep-young-shape-af9wgdv0`.
3. Go to **Dashboard** or **Connection Details** in the sidebar.
4. Click on the **Roles** section in the sidebar.
5. Find the `neondb_owner` role.
6. Click **Reset password** next to the role.
7. Copy the new password.
8. Reconstruct the full connection string with the new password.

### Update `.env`

```
DATABASE_URL=postgresql://neondb_owner:<NEW_PASSWORD>@ep-young-shape-af9wgdv0-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require
```

### Code Changes
None expected if the app reads `DATABASE_URL` from the environment.

### Verification

```bash
# Using psql
psql "postgresql://neondb_owner:<NEW_PASSWORD>@ep-young-shape-af9wgdv0-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require" -c "SELECT 1;"

# Or using node
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT NOW()').then(r => { console.log('OK:', r.rows[0]); pool.end(); }).catch(e => { console.error(e); pool.end(); });
"
```

### Critical: Check for Data Exfiltration
Run these queries to check for suspicious activity:

```sql
-- Check for recently created roles
SELECT rolname, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname NOT LIKE 'pg_%';

-- Check for recent connections (if pg_stat_activity logging is enabled)
SELECT usename, client_addr, backend_start, state FROM pg_stat_activity;
```

---

## 6. Neon PostgreSQL -- Secondary Database (hxp_m4_runner)

**Exposed value:** Full connection string including password `npg_Rs2Wx4BLVFkO` for user `neondb_owner` on endpoint `ep-curly-lake-afjwmx1t`.

### Dashboard URL
<https://console.neon.tech/app/projects>

### Steps to Rotate

1. Go to <https://console.neon.tech/app/projects>.
2. Click on the project that contains `ep-curly-lake-afjwmx1t`.
3. Navigate to **Roles** in the sidebar.
4. Find the `neondb_owner` role.
5. Click **Reset password**.
6. Copy the new password.

### Update `.env`

```
DATABASE_URL_M4='postgresql://neondb_owner:<NEW_PASSWORD>@ep-curly-lake-afjwmx1t-pooler.c-2.us-west-2.aws.neon.tech/hxp_m4_runner?sslmode=require'
```

### Verification

```bash
psql "postgresql://neondb_owner:<NEW_PASSWORD>@ep-curly-lake-afjwmx1t-pooler.c-2.us-west-2.aws.neon.tech/hxp_m4_runner?sslmode=require" -c "SELECT 1;"
```

---

## 7. Upstash Redis URL and Token

**Exposed values:**
- URL: `https://sweet-crawdad-26891.upstash.io`
- Token: `AWkLAAIncDIwODIzNjg2NjI0NmQ0NGM0OTE4NDNlZDM4YTAwZjdjN3AyMjY4OTE`

### Dashboard URL
<https://console.upstash.com/>

### Steps to Rotate

1. Go to <https://console.upstash.com/>.
2. Click on the **Redis** section.
3. Click on the database named **sweet-crawdad-26891** (or find it by URL).
4. Go to the **Details** tab.
5. Scroll down to **REST API** section.
6. Click **"Reset Token"** or **"Rotate Token"**. This instantly invalidates the old token.
7. Copy the new REST URL and REST Token.

**Note:** The URL itself may remain the same. The token is what authenticates requests.

### Update `.env`

```
UPSTASH_REDIS_REST_URL=https://sweet-crawdad-26891.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-new-upstash-token>
```

### Code Changes
None expected.

### Verification

```bash
curl "https://sweet-crawdad-26891.upstash.io/ping" \
  -H "Authorization: Bearer <your-new-token>"
```

Expected response: `{"result":"PONG"}`

### Check for Unauthorized Access
In the Upstash console, check the **Usage** and **Logs** tabs for unexpected commands or data access.

---

## 8. Firebase Web API Key

**Exposed value:** `AIzaSyC7b5P5AohsATMk-v6A_SkYO_p_QOibj0c`

### Dashboard URL
<https://console.firebase.google.com/project/hustlexp-fly-new/settings/general>

### Important Context
Firebase Web API keys are **not secret** in the traditional sense -- they are designed to be embedded in client-side code. However, since this key was exposed alongside other credentials, you should:

1. **Restrict the key** rather than rotate it (rotating a Firebase Web API key is complex).
2. **Monitor for abuse.**

### Steps to Restrict

1. Go to <https://console.cloud.google.com/apis/credentials?project=hustlexp-fly-new>.
2. Find the **Browser key** or API key matching `AIzaSyC7b5P5...`.
3. Click on it.
4. Under **Application restrictions**, select **HTTP referrers (websites)**.
5. Add your allowed domains (e.g., `hustlexp.app/*`, `localhost:3000/*`).
6. Under **API restrictions**, click **Restrict key** and select only the APIs you use (e.g., Identity Toolkit API, Firebase Installations API).
7. Click **Save**.

### If You Must Rotate the Key

1. In the Google Cloud Console credentials page above, click **"+ CREATE CREDENTIALS" > "API key"**.
2. Immediately restrict the new key as described above.
3. Update the `.env` and any client-side configurations.
4. Delete the old key.

### Update `.env`

```
FIREBASE_WEB_API_KEY=<your-new-or-restricted-key>
```

### Verification
Attempt a Firebase Auth operation (e.g., sign in) and confirm it succeeds.

---

## 9. Firebase Service Account Private Key

**Exposed value:** The entire PEM private key for `firebase-adminsdk-fbsvc@hustlexp-fly-new.iam.gserviceaccount.com`

**THIS IS THE MOST CRITICAL CREDENTIAL.** A Firebase service account private key grants full administrative access to your Firebase project, including: reading/writing all Firestore data, managing users, accessing Cloud Storage, and more.

### Dashboard URL
<https://console.firebase.google.com/project/hustlexp-fly-new/settings/serviceaccounts>

### Steps to Rotate

1. Go to <https://console.firebase.google.com/project/hustlexp-fly-new/settings/serviceaccounts>.
2. Click **"Generate new private key"**.
3. Confirm the dialog. A JSON file will be downloaded.
4. Open the downloaded JSON file.
5. Extract the `private_key` field (the PEM block starting with `-----BEGIN PRIVATE KEY-----`).
6. Extract the `client_email` field (should remain the same).

### Revoke the Old Key

1. Go to <https://console.cloud.google.com/iam-admin/serviceaccounts?project=hustlexp-fly-new>.
2. Click on `firebase-adminsdk-fbsvc@hustlexp-fly-new.iam.gserviceaccount.com`.
3. Go to the **Keys** tab.
4. Find the old key (compare the key ID if needed).
5. Click the **three dots** menu next to the old key and select **Delete**. This instantly revokes it.

### Update `.env`

Replace the entire `FIREBASE_PRIVATE_KEY` value with the new key from the downloaded JSON. Make sure to keep the surrounding double quotes and `\n` newline escapes:

```
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@hustlexp-fly-new.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n<new-key-content-here>\n-----END PRIVATE KEY-----\n"
```

**Tip:** The JSON file contains the key with literal `\n` characters. You can use this one-liner to extract and format it:

```bash
cat /path/to/downloaded-key.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
print('FIREBASE_PRIVATE_KEY=\"' + data['private_key'].replace('\n', '\\\\n') + '\"')
"
```

### Code Changes
None expected if the app reads `FIREBASE_PRIVATE_KEY` and `FIREBASE_CLIENT_EMAIL` from the environment.

### Verification

```javascript
const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
// Test: list first user
admin.auth().listUsers(1).then(r => console.log('OK:', r.users.length, 'users'));
```

### Critical: Audit Firebase Project

Check for unauthorized access immediately:

1. **Firestore:** <https://console.firebase.google.com/project/hustlexp-fly-new/firestore> -- Look for unexpected documents or collections.
2. **Authentication:** <https://console.firebase.google.com/project/hustlexp-fly-new/authentication/users> -- Look for unknown user accounts.
3. **Cloud Audit Logs:** <https://console.cloud.google.com/logs?project=hustlexp-fly-new> -- Filter for `protoPayload.authenticationInfo.principalEmail="firebase-adminsdk-fbsvc@hustlexp-fly-new.iam.gserviceaccount.com"` and look for activity you did not initiate.

---

## 10. Stripe Keys (Verify Placeholder Status)

**Exposed values:**
- `STRIPE_SECRET_KEY=sk_test_placeholder_for_verification_only`
- `STRIPE_WEBHOOK_SECRET=whsec_placeholder`

These appear to be placeholders, not real keys. However, you should verify this.

### Dashboard URL
<https://dashboard.stripe.com/test/apikeys>

### Steps to Verify and Secure

1. Go to <https://dashboard.stripe.com/test/apikeys>.
2. Check if `sk_test_placeholder_for_verification_only` appears as an actual key. It almost certainly does not -- Stripe keys have a specific format like `sk_test_51...`.
3. If it IS a real key, click **"Roll key"** next to it immediately.
4. If it is NOT a real key (expected), no rotation is needed.

### When You Add Real Stripe Keys Later

```
STRIPE_SECRET_KEY=sk_test_<your-real-test-key>
STRIPE_WEBHOOK_SECRET=whsec_<your-real-webhook-secret>
```

Never commit these to git.

---

## 11. Twilio Verify Service SID

**Exposed value:** `VA820332d36bd0ecb6c536a9397d565231`

**Note:** The `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` fields are empty, so those are not compromised. The Verify Service SID alone is not a secret that grants access -- it is an identifier, not an authentication token. However, combined with other Twilio credentials it could be used.

### Dashboard URL
<https://console.twilio.com/us1/develop/verify/services>

### Steps to Secure

1. Go to <https://console.twilio.com/us1/develop/verify/services>.
2. Verify whether the service SID `VA820332d36bd0ecb6c536a9397d565231` is actively in use.
3. If you want to rotate it:
   a. Click **"Create new Service"** to create a replacement Verify service.
   b. Configure the new service with the same settings as the old one (SMS, email channels, code length, etc.).
   c. Copy the new Service SID.
   d. Update your `.env` file.
   e. Delete the old service once the new one is confirmed working.
4. Since the Account SID and Auth Token are empty, ensure they are set securely when you add them:

### Update `.env`

```
TWILIO_ACCOUNT_SID=<your-account-sid>
TWILIO_AUTH_TOKEN=<your-auth-token>
TWILIO_VERIFY_SERVICE_SID=<your-new-service-sid>
```

### Verification

```bash
curl -X GET "https://verify.twilio.com/v2/Services/<NEW_SERVICE_SID>" \
  -u "<ACCOUNT_SID>:<AUTH_TOKEN>"
```

---

## 12. IVS Webhook Secret

**Exposed value:** `dev-secret-123`

This is clearly a development placeholder. Replace it with a cryptographically secure random string.

### Steps to Rotate

1. Generate a new secret:

```bash
openssl rand -hex 32
```

2. Update the `.env` file and whatever service sends webhooks to your app (configure the same secret on the sending side).

### Update `.env`

```
IVS_WEBHOOK_SECRET=<output-from-openssl-command>
```

### Code Changes
If any external service is configured to sign webhooks with `dev-secret-123`, update it to use the new secret as well.

---

## Post-Rotation Steps

### 1. Redeploy Your Application

After updating all credentials in `.env`:

```bash
# If deployed on a platform like Railway, Fly.io, Vercel, etc.
# Update environment variables in your deployment platform's dashboard
# Then trigger a redeploy

# Example for Fly.io:
fly secrets set OPENAI_API_KEY="sk-proj-..." DEEPSEEK_API_KEY="sk-..." # etc.

# Example for Railway:
# Use the Railway dashboard to update env vars, then redeploy
```

### 2. Verify Application Health

After redeploying:

```bash
# Hit your health check endpoint
curl https://your-app-url.com/health

# Test a few API endpoints to confirm everything works
```

### 3. Monitor for Abuse

For the next 30 days, actively monitor:

| Service         | What to Watch                                   | URL                                                        |
|-----------------|------------------------------------------------|------------------------------------------------------------|
| OpenAI          | Unexpected usage spikes                         | https://platform.openai.com/usage                          |
| DeepSeek        | Unusual API calls                               | https://platform.deepseek.com/usage                        |
| Groq            | Request volume anomalies                        | https://console.groq.com/settings/usage                    |
| Alibaba/Qwen   | API call logs                                   | https://dashscope.console.aliyun.com                       |
| Neon (primary)  | Database connections, query logs                | https://console.neon.tech                                  |
| Neon (secondary)| Database connections, query logs                | https://console.neon.tech                                  |
| Upstash         | Commands executed, data volume                  | https://console.upstash.com                                |
| Firebase        | Auth events, Firestore reads/writes             | https://console.firebase.google.com/project/hustlexp-fly-new |
| Google Cloud    | Service account activity logs                   | https://console.cloud.google.com/logs?project=hustlexp-fly-new |

### 4. Set Up Secrets Management for the Future

To prevent this from happening again:

1. **Never commit `.env` files.** Ensure `.gitignore` contains `.env*` patterns.

2. **Use a pre-commit hook** to block secrets:

```bash
# Install git-secrets
brew install git-secrets

# Set up hooks in the repo
cd /Users/sebastiandysart/Desktop/hustlexp-ai-backend
git secrets --install
git secrets --register-aws  # blocks AWS-style keys

# Add custom patterns for your key formats
git secrets --add 'sk-proj-[A-Za-z0-9_-]+'
git secrets --add 'gsk_[A-Za-z0-9]+'
git secrets --add 'sk-[a-f0-9]{32}'
git secrets --add 'npg_[A-Za-z0-9]+'
git secrets --add '-----BEGIN PRIVATE KEY-----'
```

3. **Use environment variable injection** from your deployment platform instead of `.env` files in production.

4. **Consider a secrets manager** like:
   - Doppler (<https://www.doppler.com/>)
   - HashiCorp Vault
   - Infisical (<https://infisical.com/>)
   - Your deployment platform's built-in secrets (Fly.io secrets, Vercel env vars, Railway variables)

---

## Final Completion Checklist

```
[ ] Repo made private (if it was public)
[ ] .env removed from git history (BFG or git filter-repo)
[ ] .env added to .gitignore
[ ] OpenAI key rotated and old key revoked
[ ] DeepSeek key rotated and old key revoked
[ ] Groq key rotated and old key revoked
[ ] Alibaba/Qwen key rotated and old key revoked
[ ] Neon primary DB password reset
[ ] Neon secondary DB (M4) password reset
[ ] Upstash Redis token rotated
[ ] Firebase Web API key restricted
[ ] Firebase service account key rotated and old key deleted
[ ] Stripe keys verified as placeholders
[ ] Twilio Verify service reviewed
[ ] IVS webhook secret replaced
[ ] Application redeployed with new credentials
[ ] All endpoints verified working
[ ] Collaborators notified to re-clone the repo
[ ] Monitoring dashboards checked for unauthorized usage
[ ] Pre-commit hook installed to prevent future leaks
[ ] Secrets management strategy decided for production
```

---

**This guide should be deleted or moved out of the repository once rotation is complete.** Do not commit this file to the repo, as it references credential formats and service details.
