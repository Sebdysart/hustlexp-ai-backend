# Phase D Schema Changes Summary

**Date:** 2025-01-08  
**Schema Version:** 1.3.0  
**Status:** ✅ Complete

---

## Changes Applied

### 1. Escrows Table - Version Column (Optimistic Concurrency)

**Added:**
```sql
version INTEGER NOT NULL DEFAULT 1
```

**Purpose:** Enable optimistic concurrency control for state transitions. Every UPDATE must check `WHERE version = $expectedVersion` and increment `version = version + 1`.

**Location:** `backend/database/constitutional-schema.sql` Line 272

---

### 2. Escrows Table - UNIQUE Constraints on Stripe IDs

**Added:**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrows_stripe_payment_intent_unique 
    ON escrows(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrows_stripe_transfer_unique 
    ON escrows(stripe_transfer_id) WHERE stripe_transfer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrows_stripe_refund_unique 
    ON escrows(stripe_refund_id) WHERE stripe_refund_id IS NOT NULL;
```

**Purpose:** Prevent double funding, double release, and double refund even if code logic fails. These constraints provide database-level protection.

**Location:** `backend/database/constitutional-schema.sql` Lines 297-304

---

### 3. Stripe Events Table (Replaces `processed_stripe_events`)

**Replaced:**
- Old: `processed_stripe_events` (event_id, event_type, processed_at, result, error_message)
- New: `stripe_events` (stripe_event_id, type, created, payload_json, processed_at, result, error_message, created_at)

**Key Changes:**
- Full `payload_json JSONB NOT NULL` storage (CRITICAL for replay)
- `created TIMESTAMPTZ` from Stripe event (for ordering)
- `processed_at` is nullable (NULL = unprocessed)
- Renamed `event_id` → `stripe_event_id` for clarity

**Purpose:** Store complete Stripe event payloads for replay and debugging. Essential for event-sourced payment reconciliation.

**Location:** `backend/database/constitutional-schema.sql` Lines 715-728

**Migration Note:** Old `processed_stripe_events` table should be migrated/dropped (migration script not included in schema file).

---

### 4. Terminal Immutability Trigger (Refined)

**Updated Function:**
```sql
CREATE OR REPLACE FUNCTION prevent_escrow_terminal_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state IN ('RELEASED', 'REFUNDED', 'REFUND_PARTIAL')
       AND NEW.state <> OLD.state THEN
        RAISE EXCEPTION 'HX301: Cannot transition terminal escrow state % (escrow % is terminal and immutable)', 
            OLD.state, OLD.id
            USING ERRCODE = 'HX301';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Purpose:** Prevent state transitions from terminal states (RELEASED, REFUNDED, REFUND_PARTIAL). Once escrow reaches a terminal state, it cannot transition to another state.

**Location:** `backend/database/constitutional-schema.sql` Lines 310-329

---

## Schema Version Update

**Version:** 1.3.0  
**Checksum:** `phase_d_escrow_locks`  
**Notes:** "Phase D: Escrow version, Stripe UNIQUE constraints, terminal guard, stripe_events table"

**Location:** `backend/database/constitutional-schema.sql` Line 2168-2170

---

## Next Steps

1. ✅ Schema changes complete
2. ⏳ Refactor webhook handler (verify → insert → outbox → 200)
3. ⏳ Implement `critical_payments` worker (stripe_event_received → escrow state transitions)
4. ⏳ Update EscrowService to use `version` field
5. ⏳ Update health router to check `stripe_events` instead of `processed_stripe_events`

---

## Breaking Changes

- `processed_stripe_events` table replaced with `stripe_events`
  - **Action Required:** Migrate existing data or drop old table
- `EscrowService` methods must now use `version` field for optimistic locking
- Webhook handler must store full `payload_json` (not just event_id/type)

---

## Verification Checklist

- [x] `escrows.version` column added
- [x] UNIQUE constraints on `stripe_payment_intent_id`, `stripe_transfer_id`, `stripe_refund_id`
- [x] `stripe_events` table created with `payload_json`
- [x] Terminal immutability trigger updated
- [x] Schema version bumped to 1.3.0
- [ ] Webhook handler refactored
- [ ] Payment worker implemented
- [ ] EscrowService updated to use `version`
- [ ] Health router updated
- [ ] Migration script for `processed_stripe_events` → `stripe_events`
