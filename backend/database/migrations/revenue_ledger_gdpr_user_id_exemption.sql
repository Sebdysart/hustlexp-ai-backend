-- ============================================================================
-- AUDIT FIX C1 (2026-06-11): GDPR × INV-4 collision on revenue_ledger
--
-- PROBLEM
--   GDPRService Right-to-Erasure must null `user_id` on revenue_ledger rows
--   (PII unlinking; the FK is ON DELETE SET NULL but users are UPDATEd, not
--   DELETEd, so the cascade never fires — see GDPRService D63-1..D63-3).
--   prevent_revenue_ledger_update() unconditionally raised HX701 on ANY
--   UPDATE, so every erasure transaction for a user with revenue history
--   failed and rolled back. Right-to-Erasure was permanently broken for
--   exactly the users it matters most for.
--
-- FIX (narrow exemption — option chosen with explicit sign-off)
--   Permit EXACTLY ONE transition: user_id → NULL with EVERY other column
--   unchanged. The comparison is row-generic (OLD with user_id nulled must be
--   IS NOT DISTINCT FROM NEW), so columns added in future migrations are
--   automatically covered — an UPDATE that nulls user_id while also touching
--   any other column still raises HX701. DELETEs remain fully blocked.
--   INV-4 (append-only ledger) stays always-on: no DISABLE TRIGGER windows.
--
-- IDEMPOTENT: CREATE OR REPLACE — safe to re-run.
-- Canonical definition in hardening_invariants.sql updated in the same commit.
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_revenue_ledger_update()
RETURNS TRIGGER AS $$
DECLARE
    old_with_user_nulled revenue_ledger%ROWTYPE;
BEGIN
    -- GDPR erasure exemption (audit C1): the ONLY permitted update is the
    -- PII-unlinking transition user_id → NULL, all other columns identical.
    IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN
        old_with_user_nulled := OLD;
        old_with_user_nulled.user_id := NULL;
        IF NEW IS NOT DISTINCT FROM old_with_user_nulled THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION 'INV-7_VIOLATION: revenue_ledger is append-only. Cannot update entry: %. To correct, insert a compensating entry. (Sole exemption: GDPR user_id -> NULL with no other change.)',
        OLD.id
        USING ERRCODE = 'HX701';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION prevent_revenue_ledger_update() IS
    'Append-only guard for revenue_ledger (INV-4/HX701). Single sanctioned exemption: GDPR PII unlink (user_id -> NULL, all other columns unchanged). See migrations/revenue_ledger_gdpr_user_id_exemption.sql';
