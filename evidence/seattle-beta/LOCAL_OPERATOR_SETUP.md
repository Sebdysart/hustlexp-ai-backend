# Local Operator Environment Setup

**Run Gate-1 tests from YOUR terminal, not from chat.**

---

## Step 1: Install Prerequisites

```bash
# Firebase CLI
npm install -g firebase-tools

# Verify
firebase --version
```

---

## Step 2: Firebase Login & Test User Setup

```bash
# Login to Firebase
firebase login

# List projects
firebase projects:list
```

### Create Test Users in Firebase Console

1. Go to: https://console.firebase.google.com/project/YOUR_PROJECT/authentication/users
2. Click "Add user"
3. Create:
   - `poster_test@hustlexp.com` / password: `TestPoster123!`
   - `hustler_test@hustlexp.com` / password: `TestHustler123!`

---

## Step 3: Get Firebase ID Tokens

### Option A: REST API (Recommended)

```bash
# Get your Firebase Web API Key from:
# Firebase Console → Project Settings → General → Web API Key

export FIREBASE_API_KEY="YOUR_WEB_API_KEY"

# Sign in poster and get token
curl -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "poster_test@hustlexp.com",
    "password": "TestPoster123!",
    "returnSecureToken": true
  }'

# Response contains: "idToken": "eyJ..."
# Save it:
export POSTER_TOKEN="eyJ..."

# Sign in hustler
curl -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "hustler_test@hustlexp.com",
    "password": "TestHustler123!",
    "returnSecureToken": true
  }'

export HUSTLER_TOKEN="eyJ..."
```

---

## Step 4: Set Environment Variables

```bash
# Create ops.env file
cat > ops.env << 'EOF'
# Deployment target
export HOST="https://hustlexp-ai-backend-production.up.railway.app"

# Firebase
export FIREBASE_API_KEY="YOUR_WEB_API_KEY"

# Test credentials (DO NOT COMMIT)
export POSTER_EMAIL="poster_test@hustlexp.com"
export POSTER_PASSWORD="TestPoster123!"
export HUSTLER_EMAIL="hustler_test@hustlexp.com"
export HUSTLER_PASSWORD="TestHustler123!"

# Tokens (populated after login)
export POSTER_TOKEN=""
export HUSTLER_TOKEN=""
EOF

# Load it
source ops.env
```

---

## Step 5: Helper Script for Token Refresh

```bash
# Create get-tokens.sh
cat > get-tokens.sh << 'EOF'
#!/bin/bash
source ops.env

echo "Getting poster token..."
POSTER_RESPONSE=$(curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$POSTER_EMAIL\",\"password\":\"$POSTER_PASSWORD\",\"returnSecureToken\":true}")

export POSTER_TOKEN=$(echo $POSTER_RESPONSE | jq -r '.idToken')
echo "POSTER_TOKEN set (${#POSTER_TOKEN} chars)"

echo "Getting hustler token..."
HUSTLER_RESPONSE=$(curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$HUSTLER_EMAIL\",\"password\":\"$HUSTLER_PASSWORD\",\"returnSecureToken\":true}")

export HUSTLER_TOKEN=$(echo $HUSTLER_RESPONSE | jq -r '.idToken')
echo "HUSTLER_TOKEN set (${#HUSTLER_TOKEN} chars)"

echo "Tokens ready. Run: source ops.env"
EOF

chmod +x get-tokens.sh
```

---

## Step 6: Verify Railway Deployment

```bash
# Check health
curl $HOST/health

# Expected: {"status":"ok","timestamp":"..."}

# Verify commit deployed
# Go to: https://railway.app/dashboard → Your Project → Deployments
# Confirm: commit 7fdef29
```

---

## Step 7: Run Gate-1 Tests

### Test 1: Auth Required (should fail without token)

```bash
curl -X POST "$HOST/api/escrow/create" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"test","hustlerId":"test","amount":100,"paymentMethodId":"pm_card_visa"}'

# Expected: {"error":"Authorization header required","code":"MISSING_TOKEN"}
```

### Test 2: Auth Works (with token)

```bash
curl -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"test-001","hustlerId":"hustler-id","amount":100,"paymentMethodId":"pm_card_visa"}'

# If Stripe configured: escrow record or Stripe error
# If not: might fail with customer issue (we need to fix that)
```

---

## Checklist

- [ ] Firebase CLI installed
- [ ] Test users created in Firebase Console
- [ ] Web API Key obtained
- [ ] ops.env file created
- [ ] get-tokens.sh works
- [ ] Health endpoint returns 200
- [ ] Railway shows commit 7fdef29
- [ ] Auth rejection test passes (no token → 401)

---

## Next Steps After Setup

1. Run all Gate-1 negative tests first
2. Capture evidence (screenshots, logs)
3. Fix any failures
4. Re-run and document

---

*Created: 2024-12-09*
*For: Seattle Beta Gate-1 Testing*
