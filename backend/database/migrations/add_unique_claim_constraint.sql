-- F61-1 FIX: Prevent duplicate insurance claims for the same (task_id, hustler_id)
-- when the claim is in an active state (not denied or withdrawn).
--
-- The SELECT ... FOR UPDATE duplicate check in fileClaim() acquires no lock when
-- no rows exist, allowing two concurrent calls to both find 0 rows and both INSERT —
-- creating duplicate pending claims. This partial unique index makes the second
-- concurrent INSERT fail with a unique constraint violation, which is caught and
-- surfaced as CLAIM_ALREADY_EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_insurance_claims_unique_active
ON insurance_claims (task_id, hustler_id)
WHERE status NOT IN ('denied', 'withdrawn');
