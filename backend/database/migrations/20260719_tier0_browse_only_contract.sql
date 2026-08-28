-- HX/OS provider progression correction.
-- Tier 0 (Explorer) may browse and save only. Any transition into ACCEPTED
-- requires Tier 1+, verified identity/phone, and a payout-ready account.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_trust_tier_check;
ALTER TABLE users
  ADD CONSTRAINT users_trust_tier_check
  CHECK (trust_tier IN (0, 1, 2, 3, 4, 9));
ALTER TABLE users ALTER COLUMN trust_tier SET DEFAULT 0;

ALTER TABLE capability_profiles DROP CONSTRAINT IF EXISTS capability_profiles_trust_tier_check;
ALTER TABLE capability_profiles
  ADD CONSTRAINT capability_profiles_trust_tier_check
  CHECK (trust_tier BETWEEN 0 AND 4);
ALTER TABLE capability_profiles ALTER COLUMN trust_tier SET DEFAULT 0;

CREATE OR REPLACE FUNCTION enforce_task_worker_eligibility_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_worker RECORD;
  v_active_tasks INTEGER;
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;

  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXWE1: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.poster_id = NEW.worker_id THEN
    RAISE EXCEPTION 'HXWE2: poster cannot accept their own task' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    u.default_mode,
    u.account_status,
    u.is_minor,
    u.is_banned,
    u.trust_hold,
    u.trust_hold_until,
    u.trust_tier AS worker_trust_tier,
    u.is_verified,
    u.phone,
    u.plan,
    u.stripe_connect_id,
    u.payouts_enabled,
    cp.trust_tier AS profile_trust_tier,
    cp.risk_clearance
  INTO v_worker
  FROM users u
  JOIN capability_profiles cp ON cp.user_id = u.id
  WHERE u.id = NEW.worker_id;

  IF NOT FOUND OR v_worker.default_mode <> 'worker' THEN
    RAISE EXCEPTION 'HXWE3: eligible worker authority is missing' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.account_status <> 'ACTIVE' OR v_worker.is_minor OR v_worker.is_banned THEN
    RAISE EXCEPTION 'HXWE4: worker account is not active and eligible' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.trust_hold
     AND (v_worker.trust_hold_until IS NULL OR v_worker.trust_hold_until > clock_timestamp()) THEN
    RAISE EXCEPTION 'HXWE5: worker has an active trust hold' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.stripe_connect_id IS NULL OR NOT v_worker.payouts_enabled THEN
    RAISE EXCEPTION 'HXWE6: worker payout account is not ready' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.profile_trust_tier IS DISTINCT FROM v_worker.worker_trust_tier THEN
    RAISE EXCEPTION 'HXWE7: worker capability profile is stale' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < 1
     OR NOT v_worker.is_verified
     OR NULLIF(BTRIM(v_worker.phone), '') IS NULL THEN
    RAISE EXCEPTION 'HXWE15: Tier 0 is browse-only; verified identity and phone are required' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.risk_level = 'IN_HOME' OR NOT (lower(NEW.risk_level) = ANY(v_worker.risk_clearance)) THEN
    RAISE EXCEPTION 'HXWE8: worker lacks task risk clearance' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < COALESCE(NEW.trust_tier_required, 1) THEN
    RAISE EXCEPTION 'HXWE9: worker trust tier is insufficient' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.price > (CASE
      WHEN v_worker.worker_trust_tier = 1 THEN 5000
      WHEN v_worker.worker_trust_tier = 2 THEN 20000
      ELSE 9999900
    END) THEN
    RAISE EXCEPTION 'HXWE10: task value exceeds worker trust authority' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.risk_level = 'HIGH'
     AND v_worker.plan <> 'pro'
     AND NOT EXISTS (
       SELECT 1 FROM plan_entitlements entitlement
       WHERE entitlement.user_id = NEW.worker_id
         AND (entitlement.task_id IS NULL OR entitlement.task_id = NEW.id)
         AND entitlement.risk_level = 'HIGH'
         AND entitlement.expires_at > clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'HXWE11: high-risk work requires Pro or an active entitlement' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM escrows escrow
    WHERE escrow.task_id = NEW.id AND escrow.state = 'FUNDED'
  ) THEN
    RAISE EXCEPTION 'HXWE12: task is not funded' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM disputes dispute
    WHERE dispute.worker_id = NEW.worker_id
      AND dispute.state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED')
  ) THEN
    RAISE EXCEPTION 'HXWE13: worker has an active dispute' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_active_tasks
  FROM tasks active_task
  WHERE active_task.worker_id = NEW.worker_id
    AND active_task.id <> NEW.id
    AND active_task.state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED');
  IF v_active_tasks >= 5 THEN
    RAISE EXCEPTION 'HXWE14: worker active-task capacity is exhausted' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_task_worker_eligibility_on_accept() IS
  'HX/OS acceptance backstop: Tier 0 browse-only; Tier 1+ verified adult active worker, no ban/hold, payout ready, current capability, trust/risk/value/plan authority, funded escrow, no active dispute, and capacity.';
