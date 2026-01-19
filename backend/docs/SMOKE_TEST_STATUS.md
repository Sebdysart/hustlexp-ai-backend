# Alpha Telemetry Smoke Test Status

## Implementation Complete

The smoke test script has been created at `scripts/smoke-test-alpha-telemetry.ts`.

The script simulates all 5 scenarios:
1. E1: No Tasks Available
2. E2: Eligibility Mismatch
3. E3: Trust Tier Locked
4. Trust Promotion → Exit Loop
5. XP Award Truth Check

## Execution Requirements

The smoke test requires:
- `DATABASE_URL` environment variable set
- Database accessible
- Schema migrations applied (`alpha_telemetry` table exists)

To run:
```bash
DATABASE_URL=$DATABASE_URL npx tsx scripts/smoke-test-alpha-telemetry.ts
```

## Test Validation

The script validates:
- ✅ Each scenario produces exactly one impression
- ✅ Each exit has believable duration (≥ 250ms)
- ✅ No edge states fire when they shouldn't
- ✅ Trust deltas align with real state changes
- ✅ XP deltas are tied to correct tasks

## Note on Frontend Integration

The smoke test script simulates **backend telemetry calls** directly.

For **complete validation**, the actual React Native frontend screens (E1, E2, E3) need to be:
1. Integrated into the app navigation
2. Tested manually or via E2E tests
3. Verified that tRPC mutations are called correctly

The backend telemetry infrastructure is ready and will capture events when the frontend is wired into the live app.

## Next Steps

Once the smoke test passes:
- Frontend screens (E1, E2, E3) can be integrated into navigation
- Manual testing can validate full user journey
- Dashboard queries can be validated with real telemetry data
