-- Append-only repair for the Universal V1 reconciliation trigger.
--
-- The original function declared a PL/pgSQL record named "predecessor" and
-- reused that identifier as the recursive CTE join alias. PostgreSQL therefore
-- resolved predecessor.event_id against the record and rejected valid terminal
-- fake-finance reconciliation facts. This migration changes identifiers only;
-- every HXUV1 reconciliation invariant and the trigger timing remain intact.
-- It does not mutate business data or enable any production money capability.

CREATE OR REPLACE FUNCTION enforce_universal_reconciliation_bindings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  prior_reconciliation task_reconciliation_facts%ROWTYPE;
  work_order task_work_orders%ROWTYPE;
  scope task_scope_versions%ROWTYPE;
  void_event task_financial_security_events%ROWTYPE;
  capture task_financial_security_events%ROWTYPE;
  refund task_financial_security_events%ROWTYPE;
  reversal task_financial_security_events%ROWTYPE;
  settlement task_financial_security_events%ROWTYPE;
  funding task_financial_security_events%ROWTYPE;
  provider_release task_financial_security_events%ROWTYPE;
  payout task_financial_security_events%ROWTYPE;
  bank_settlement task_financial_security_events%ROWTYPE;
  total_refunded BIGINT;
BEGIN
  IF NEW.expected_version <> NEW.reconciliation_version - 1 THEN
    RAISE EXCEPTION 'HXUV1-REC-1: reconciliation expected version must name the prior Work Order snapshot'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.reconciliation_version > 1 THEN
    SELECT * INTO prior_reconciliation
    FROM task_reconciliation_facts
    WHERE id = NEW.supersedes_fact_id;
    IF NOT FOUND
       OR prior_reconciliation.work_order_id <> NEW.work_order_id
       OR prior_reconciliation.reconciliation_version <> NEW.reconciliation_version - 1 THEN
      RAISE EXCEPTION 'HXUV1-REC-2: reconciliation revisions must form one exact Work Order chain'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT * INTO work_order FROM task_work_orders WHERE id = NEW.work_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-REC-3: reconciliation requires an existing Work Order'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO scope
  FROM task_scope_versions
  WHERE id = COALESCE(
    (
      SELECT amendment.scope_version_id
      FROM task_work_order_amendments amendment
      WHERE amendment.work_order_id = NEW.work_order_id
      ORDER BY amendment.amendment_version DESC
      LIMIT 1
    ),
    work_order.scope_version_id
  );

  IF NEW.void_event_id IS NOT NULL THEN
    SELECT * INTO void_event FROM task_financial_security_events WHERE id = NEW.void_event_id;
    IF NOT FOUND OR void_event.event_kind <> 'VOIDED'
       OR void_event.task_id <> work_order.task_id
       OR void_event.scope_version_id <> scope.id
       OR void_event.currency <> NEW.currency
       OR void_event.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.void_state = 'VOIDED' AND void_event.status = 'SUCCEEDED')
         OR (NEW.void_state = 'PENDING' AND void_event.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.void_state = 'FAILED' AND void_event.status IN ('DECLINED','FAILED'))
         OR NEW.void_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-14: void state requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.capture_event_id IS NOT NULL THEN
    SELECT * INTO capture FROM task_financial_security_events WHERE id = NEW.capture_event_id;
    IF NOT FOUND OR capture.event_kind <> 'CAPTURED'
       OR capture.task_id <> work_order.task_id
       OR capture.scope_version_id <> scope.id
       OR capture.currency <> NEW.currency
       OR capture.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.capture_state = 'CAPTURED' AND capture.status = 'SUCCEEDED')
         OR (NEW.capture_state = 'PENDING' AND capture.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR NEW.capture_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-4: capture state requires the exact capture fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.refund_event_id IS NOT NULL THEN
    SELECT * INTO refund FROM task_financial_security_events WHERE id = NEW.refund_event_id;
    IF NOT FOUND OR refund.event_kind <> 'REFUNDED'
       OR refund.task_id <> work_order.task_id
       OR refund.scope_version_id <> scope.id
       OR refund.currency <> NEW.currency
       OR NOT (
         (NEW.refund_state = 'REFUNDED' AND refund.status = 'SUCCEEDED')
         OR (NEW.refund_state = 'PENDING' AND refund.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.refund_state = 'FAILED' AND refund.status IN ('DECLINED','FAILED'))
         OR NEW.refund_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-5: refund state requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.reversal_event_id IS NOT NULL THEN
    SELECT * INTO reversal FROM task_financial_security_events WHERE id = NEW.reversal_event_id;
    IF NOT FOUND OR reversal.event_kind <> 'REVERSED'
       OR reversal.task_id <> work_order.task_id
       OR reversal.scope_version_id <> scope.id
       OR reversal.currency <> NEW.currency
       OR reversal.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.reversal_state = 'REVERSED' AND reversal.status = 'SUCCEEDED')
         OR (NEW.reversal_state = 'PENDING' AND reversal.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.reversal_state = 'FAILED' AND reversal.status IN ('DECLINED','FAILED'))
         OR NEW.reversal_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-6: reversal state requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.settlement_event_id IS NOT NULL THEN
    SELECT * INTO settlement FROM task_financial_security_events WHERE id = NEW.settlement_event_id;
    IF NOT FOUND OR settlement.event_kind <> 'SETTLEMENT_OBSERVED'
       OR settlement.task_id <> work_order.task_id
       OR settlement.scope_version_id <> scope.id
       OR settlement.currency <> NEW.currency
       OR settlement.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.settlement_state = 'SETTLED' AND settlement.status = 'SUCCEEDED')
         OR (NEW.settlement_state = 'PENDING' AND settlement.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.settlement_state = 'FAILED' AND settlement.status IN ('DECLINED','FAILED'))
         OR NEW.settlement_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-7: settlement requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.funding_event_id IS NOT NULL THEN
    SELECT * INTO funding FROM task_financial_security_events WHERE id = NEW.funding_event_id;
    IF NOT FOUND OR funding.event_kind <> 'FUNDING_OBSERVED'
       OR funding.task_id <> work_order.task_id
       OR funding.scope_version_id <> scope.id
       OR funding.currency <> NEW.currency
       OR funding.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.funding_state = 'FUNDED' AND funding.status = 'SUCCEEDED')
         OR (NEW.funding_state = 'PENDING' AND funding.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.funding_state = 'FAILED' AND funding.status IN ('DECLINED','FAILED'))
         OR NEW.funding_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-8: funding requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.provider_release_event_id IS NOT NULL THEN
    SELECT * INTO provider_release
    FROM task_financial_security_events WHERE id = NEW.provider_release_event_id;
    IF NOT FOUND OR provider_release.event_kind <> 'PROVIDER_RELEASED'
       OR provider_release.task_id <> work_order.task_id
       OR provider_release.scope_version_id <> scope.id
       OR provider_release.currency <> NEW.currency
       OR provider_release.amount_cents <> scope.hustler_payout_cents
       OR NOT (
         (NEW.provider_release_state = 'RELEASED' AND provider_release.status = 'SUCCEEDED')
         OR (NEW.provider_release_state = 'PENDING' AND provider_release.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.provider_release_state = 'FAILED' AND provider_release.status IN ('DECLINED','FAILED'))
         OR NEW.provider_release_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-9: provider release requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.payout_event_id IS NOT NULL THEN
    SELECT * INTO payout FROM task_financial_security_events WHERE id = NEW.payout_event_id;
    IF NOT FOUND OR payout.event_kind <> 'PAYOUT_OBSERVED'
       OR payout.task_id <> work_order.task_id
       OR payout.scope_version_id <> scope.id
       OR payout.currency <> NEW.currency
       OR payout.amount_cents <> scope.hustler_payout_cents
       OR NOT (
         (NEW.payout_state = 'PAID' AND payout.status = 'SUCCEEDED')
         OR (NEW.payout_state = 'PENDING' AND payout.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.payout_state = 'FAILED' AND payout.status IN ('DECLINED','FAILED'))
         OR NEW.payout_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-10: payout requires its own exact fact and is not release'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.bank_settlement_event_id IS NOT NULL THEN
    SELECT * INTO bank_settlement
    FROM task_financial_security_events WHERE id = NEW.bank_settlement_event_id;
    IF NOT FOUND OR bank_settlement.event_kind <> 'BANK_SETTLEMENT_OBSERVED'
       OR bank_settlement.task_id <> work_order.task_id
       OR bank_settlement.scope_version_id <> scope.id
       OR bank_settlement.currency <> NEW.currency
       OR bank_settlement.amount_cents <> scope.hustler_payout_cents
       OR NOT (
         (NEW.bank_settlement_state = 'SETTLED' AND bank_settlement.status = 'SUCCEEDED')
         OR (NEW.bank_settlement_state = 'PENDING' AND bank_settlement.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.bank_settlement_state = 'FAILED' AND bank_settlement.status IN ('DECLINED','FAILED'))
         OR NEW.bank_settlement_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-11: release and payout are never bank settlement'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.reconciliation_state IN ('MATCHED','CLOSED') THEN
    SELECT COALESCE(sum(event.amount_cents), 0) INTO total_refunded
    FROM task_financial_security_events event
    WHERE event.task_draft_id = work_order.task_draft_id
      AND event.task_id = work_order.task_id
      AND event.eligibility_decision_id = work_order.eligibility_decision_id
      AND event.scope_version_id = scope.id
      AND event.event_kind = 'REFUNDED'
      AND event.status = 'SUCCEEDED'
      AND event.currency = NEW.currency;

    IF NEW.reconciliation_state = 'CLOSED'
       AND (
         NEW.void_state = 'VOIDED'
         OR NEW.reversal_state = 'REVERSED'
         OR (
           NEW.capture_state = 'CAPTURED'
           AND NEW.refund_state = 'REFUNDED'
           AND NEW.settlement_state = 'NOT_APPLICABLE'
         )
       ) THEN
      IF NEW.customer_ledger_amount_cents <> 0
         OR NEW.provider_ledger_amount_cents <> 0
         OR (
           NEW.refund_state = 'REFUNDED'
           AND total_refunded <> scope.customer_total_cents
         ) THEN
        RAISE EXCEPTION 'HXUV1-REC-12: closed negative path must reconcile exact zero-value ledgers'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF NEW.customer_ledger_amount_cents <> scope.customer_total_cents - total_refunded
       OR NEW.provider_ledger_amount_cents <> scope.hustler_payout_cents THEN
      RAISE EXCEPTION 'HXUV1-REC-12: matched reconciliation amounts must equal the immutable customer and provider ledgers'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (
    WITH RECURSIVE authority_chain(event_id) AS (
      SELECT work_order.financial_security_event_id
      UNION
      SELECT successor.id
      FROM task_financial_security_events successor
      JOIN authority_chain chain_predecessor
        ON successor.predecessor_event_id = chain_predecessor.event_id
    )
    SELECT 1
    FROM unnest(ARRAY[
      NEW.void_event_id,
      NEW.capture_event_id,
      NEW.refund_event_id,
      NEW.reversal_event_id,
      NEW.settlement_event_id,
      NEW.funding_event_id,
      NEW.provider_release_event_id,
      NEW.payout_event_id,
      NEW.bank_settlement_event_id
    ]) AS linked(event_id)
    JOIN task_financial_security_events event ON event.id = linked.event_id
    WHERE linked.event_id IS NOT NULL
      AND (
        event.task_draft_id IS DISTINCT FROM work_order.task_draft_id
        OR event.task_id IS DISTINCT FROM work_order.task_id
        OR event.eligibility_decision_id IS DISTINCT FROM work_order.eligibility_decision_id
        OR NOT EXISTS (
          SELECT 1 FROM authority_chain chain
          WHERE chain.event_id = event.id
        )
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-REC-13: every reconciliation fact must belong to the exact Work Order authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_reconciliation_bindings_guard ON task_reconciliation_facts;
CREATE TRIGGER universal_reconciliation_bindings_guard
BEFORE INSERT ON task_reconciliation_facts
FOR EACH ROW EXECUTE FUNCTION enforce_universal_reconciliation_bindings();
