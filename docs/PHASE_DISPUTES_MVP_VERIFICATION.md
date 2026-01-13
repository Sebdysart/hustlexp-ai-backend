# Phase D Disputes MVP Verification

This document describes how to run the "evil tests" that verify dispute resolution correctness under failure conditions.

## Prerequisites

1. **Redis running**:
   ```bash
   docker run -d -p 6379:6379 redis:7-alpine
   # OR
   redis-server
   ```

2. **Database accessible**: `DATABASE_URL` environment variable set

3. **Workers running** (Terminal A):
   ```bash
   npm install
   npm run db:migrate
   npm run dev:workers
   ```

## Evil Test B: Unknown Job Name

Tests that unknown job types in `critical_payments` queue are rejected.

**Run:**
```bash
npm run evil:b
```

**Expected:**
- Worker logs show: `Unknown event type in critical_payments queue: foo.bar. Expected escrow.*_requested or payment.*`
- Job fails (as designed)
- PaymentWorker is never invoked

**Done criteria:** Job is rejected with explicit error message.

## Evil Test A: SPLIT Transfer Failure

Tests that SPLIT resolution does NOT terminalize escrow when transfer creation fails.

**Important:** This test requires workers to be restarted between phases because `HX_FAIL_STRIPE_TRANSFER` is read from the worker process environment, not the job payload.

### Phase 1: Transfer Failure

1. **Start workers with failure injection** (Terminal A):
   ```bash
   HX_STRIPE_STUB=1 HX_FAIL_STRIPE_TRANSFER=1 npm run dev:workers
   ```

2. **Run test script** (Terminal B):
   ```bash
   HX_STRIPE_STUB=1 npm run evil:a
   ```

3. **Stop workers** (Terminal A: Ctrl+C)

### Phase 2: Retry Success

1. **Restart workers without failure flag** (Terminal A):
   ```bash
   HX_STRIPE_STUB=1 npm run dev:workers
   ```

2. **Run test script again** (Terminal B):
   ```bash
   HX_STRIPE_STUB=1 npm run evil:a
   ```

**Expected output:**
1. Phase 1 (transfer fails):
   - Escrow state: `LOCKED_DISPUTE`
   - `stripe_transfer_id`: `NULL`
   - `stripe_refund_id`: May exist (refund may succeed)

2. Phase 2 (retry succeeds):
   - Escrow state: `REFUND_PARTIAL`
   - Both `stripe_refund_id` and `stripe_transfer_id` exist
   - `refund_amount`: 3000
   - `release_amount`: 7000

**Done criteria:**
- No terminalization without transferId
- Retry converges to REFUND_PARTIAL
- Only one refund, only one transfer (idempotency)
- Script output ends with `EVIL_A_PASS` or `EVIL_A_FAIL`

## What to Paste in PR

After running both tests, paste:

1. **Evil Test B output**: Worker log line showing rejection
2. **Evil Test A output**: DB snapshots from both phases
3. **Invariant tests**: `npm run test:invariants` output

## Notes

- Both tests require `HX_STRIPE_STUB=1` to avoid real Stripe network calls
- Evil Test A requires workers to be running (processes the enqueued jobs)
- Tests clean up their own data after completion
