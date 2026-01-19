# Transaction Error Handling Fix - Removal Gate Documentation

## Fix Summary

**Bug**: Transaction ROLLBACK failures were masking original transaction errors, making root cause diagnosis impossible.

**Fix**: Wrapped ROLLBACK operations in try-catch blocks to:
- Log both errors (original + rollback failure)
- Always throw the original error (never the rollback error)
- Ensure connection release still happens in finally block

**Files Fixed**:
- `src/db/index.ts` (line 71-81)
- `backend/src/db.ts` (lines 274-281 and 305-312)

## Removal Gate Criteria

**DO NOT remove instrumentation or downgrade logging until ALL of the following are true:**

1. ✅ **Alpha traffic has exercised failure paths**
   - At least one real transaction failure observed in production/logs
   - Ideally one rollback failure scenario (even simulated)

2. ✅ **Log volume is confirmed acceptable**
   - No spam or excessive logging
   - Only fires on exceptional paths (transaction failures)

3. ✅ **Regression test exists and passes**
   - Test file: `backend/tests/invariants/transaction-error-handling.test.ts`
   - Verifies original error is preserved when rollback fails
   - Locks behavior forever

## Why This Fix Matters

This fix addresses a **high-severity failure mode**:
- Failed `ROLLBACK` masking the *original* error

This is not cosmetic. This is how:
- Corrupted state propagates
- Retries behave incorrectly
- Root causes get permanently lost

## Current Behavior (Post-Fix)

```typescript
catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    logger.error({ originalError: error, rollbackError }, 'ROLLBACK failed');
  }
  throw error; // Always throw original error
}
```

**Correctness**: ✅ Original error always thrown  
**Observability**: ✅ Rollback failure is logged, not authoritative  
**Connection Management**: ✅ Connection release guaranteed in finally

## When to Revisit

After alpha completes:
1. Review log volume and patterns
2. Verify no rollback failures occurred (or verify fix handled them correctly)
3. Consider downgrading from `error` to `warn` if no rollback failures observed
4. **DO NOT** remove the try-catch structure - that is permanent correctness

## Related Test

See: `backend/tests/invariants/transaction-error-handling.test.ts`

This structural test verifies:
- Try-catch around ROLLBACK exists
- Original error is thrown (not rollback error)
- Both errors are logged
- Connection always released
