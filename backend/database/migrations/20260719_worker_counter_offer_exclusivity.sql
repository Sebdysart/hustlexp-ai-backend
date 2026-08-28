-- A funded source task can authorize exactly one counter replacement path.
-- Pending and rejected proposals may coexist, but only one approval may survive
-- into customer reauthorization or materialization.

CREATE UNIQUE INDEX IF NOT EXISTS worker_counter_offers_one_authorized_replacement
  ON worker_counter_offers(task_id)
  WHERE status IN ('APPROVED_REAUTH_REQUIRED', 'MATERIALIZED');
