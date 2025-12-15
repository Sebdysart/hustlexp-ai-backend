# Manual User Fixes Required (fixesMUF)

The backend code is completely fixed and the server is running. However, to make the app **functional**, you must manually update the configuration with real credentials.

## 1. Update Environment Variables
Open the file `.env.dev` (or create `.env.local`) and replace the "mock" values with your real API keys.

### Database
- **Issue**: The current `DATABASE_URL` failed to connect during startup.
- **Action**: Update `DATABASE_URL` with a valid Neon connection string.
```properties
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
```

### Redis (Upstash)
- **Issue**: Currently set to `mock-redis-url`.
- **Action**: Add your Upstash REST URL and Token.
```properties
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

### AI Providers
- **Issue**: All keys are set to `sk-mock-key`.
- **Action**: Add keys for the AI models you intend to use.
```properties
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=...
GROQ_API_KEY=...
```

### Stripe
- **Issue**: Using a mock test key.
- **Action**: Add your Stripe Test Secret Key.
```properties
STRIPE_SECRET_KEY=sk_test_...
```

## 2. Initialize Database
Once you have valid DB credentials, run the schema setup scripts:

```bash
# 1. Setup Main Schema
npm run db:setup

# 2. Setup Ledger Schema
npm run db:setup:ledger
```

## 3. Verify
After updating keys:
1. Stop the server (`Ctrl+C`).
2. Run `npm run dev`.
3. Check console for "Database: ✓ Connected".
