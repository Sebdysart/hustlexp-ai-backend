# Step 1: Stripe CLI Webhook Replay - Manual Execution Required

## Status: ⏳ PENDING MANUAL EXECUTION

**Cannot be fully automated** - requires Stripe CLI interaction and server running.

---

## Execution Instructions

### Terminal 1: Start Server
```bash
cd /Users/sebastiandysart/HustleXP/hustlexp-ai-backend
export DATABASE_URL='postgresql://neondb_owner:REDACTED_NEON_PASSWORD_2@REDACTED_NEON_HOST_2-pooler.c-2.us-west-2.aws.neon.tech/hxp_m4_runner?sslmode=require&channel_binding=require'
npm run dev
```

### Terminal 2: Start Stripe CLI Listener
```bash
cd /Users/sebastiandysart/HustleXP/hustlexp-ai-backend
./scripts/step1-verify-webhook-replay.sh
```

### Terminal 3: Trigger and Replay Events
```bash
# Trigger first event
stripe trigger customer.subscription.created

# Note the event ID from output (evt_xxx)
# Then replay the same event twice
stripe events resend <event_id>
stripe events resend <event_id>
```

### Terminal 4: Check Results
```bash
cd /Users/sebastiandysart/HustleXP/hustlexp-ai-backend
export DATABASE_URL='postgresql://neondb_owner:REDACTED_NEON_PASSWORD_2@REDACTED_NEON_HOST_2-pooler.c-2.us-west-2.aws.neon.tech/hxp_m4_runner?sslmode=require&channel_binding=require'
npx tsx scripts/step1-check-results.ts
```

---

## Pass Criteria (All Required)

- [ ] No duplicate rows in `stripe_events`
- [ ] No duplicate entitlements
- [ ] No double side effects
- [ ] Second delivery is strict no-op
- [ ] Logs explicitly show idempotent handling

---

## Result

**Status:** ⏳ PENDING - Requires manual execution with Stripe CLI

**Next:** After Step 1 passes, proceed to Step 4 (Production verification)
