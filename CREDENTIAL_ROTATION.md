# CREDENTIAL ROTATION GUIDE

**URGENT**: All credentials below were exposed in git history and MUST be rotated immediately.

## Rotation Checklist

### 1. OpenAI API Key
- Go to: https://platform.openai.com/api-keys
- Delete the old key
- Generate a new key
- Update `OPENAI_API_KEY` in your deployment environment

### 2. DeepSeek API Key
- Go to: https://platform.deepseek.com/api_keys
- Revoke the old key
- Generate a new key
- Update `DEEPSEEK_API_KEY` in your deployment environment

### 3. Groq API Key
- Go to: https://console.groq.com/keys
- Delete the old key
- Generate a new key
- Update `GROQ_API_KEY` in your deployment environment

### 4. Alibaba / Qwen API Key
- Go to: Alibaba Cloud Console > API Key Management
- Revoke the old key
- Generate a new key
- Update `ALIBABA_API_KEY` / `QWEN_API_KEY` in your deployment environment

### 5. Neon PostgreSQL
- Go to: https://console.neon.tech
- Navigate to your project > Settings > Connection String
- Reset the database password
- Update `DATABASE_URL` in your deployment environment

### 6. Upstash Redis
- Go to: https://console.upstash.com
- Navigate to your database > REST API tab
- Rotate the token
- Update `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `UPSTASH_REDIS_URL`

### 7. Firebase Admin SDK
- Go to: https://console.firebase.google.com
- Navigate to Project Settings > Service Accounts
- Generate a new private key (this invalidates the old one)
- Update `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`

### 8. Firebase Web API Key
- Go to: https://console.firebase.google.com
- Navigate to Project Settings > General
- Consider restricting the API key in Google Cloud Console
- Update `FIREBASE_WEB_API_KEY`

### 9. Stripe Keys (if exposed)
- Go to: https://dashboard.stripe.com/apikeys
- Roll the secret key
- Update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`

## After Rotation

1. Run the git history purge script: `./scripts/purge-env-from-history.sh`
2. Force push: `git push --force --all`
3. Verify all services still work with the new credentials
4. Monitor for unauthorized usage of old credentials for 30 days
