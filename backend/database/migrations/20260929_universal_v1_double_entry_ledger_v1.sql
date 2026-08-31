-- Universal V1 provider-neutral double-entry ledger v1.
--
-- This append-only engine contract installs before the post-engine fake
-- provider fixtures. Fake terminal authority is optional at engine-migration
-- apply time: the deferred reconciliation trigger discovers it dynamically
-- once the nonproduction fixture chain is present. Every ledger row is then
-- derived only from one exact immutable terminal intent, fake reconciliation
-- bridge, canonical reconciliation fact, and canonical lifecycle-event chain.
-- Caller-supplied reconciliation totals are never ledger authority. The exact
-- customer-minus-provider residual is SUSPENSE_UNALLOCATED; no fee or revenue
-- policy is inferred. This migration creates no provider I/O and no external
-- effect. Production payment creation remains frozen.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.task_reconciliation_facts') IS NULL
     OR to_regclass('public.task_financial_security_events') IS NULL
     OR to_regclass('public.task_work_orders') IS NULL
     OR to_regclass('public.tasks') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-0: canonical Universal V1 lifecycle authority must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.universal_v1_ledger_accounts_v1 (
  account_code TEXT PRIMARY KEY CHECK (account_code IN (
    'PROVIDER_CLEARING_ASSET',
    'CASH_CONTROL_ASSET',
    'CUSTOMER_HELD_LIABILITY',
    'PROVIDER_PAYABLE_LIABILITY',
    'PAYOUT_CLEARING_LIABILITY',
    'BANK_IN_TRANSIT_LIABILITY',
    'SUSPENSE_UNALLOCATED'
  )),
  account_class TEXT NOT NULL CHECK (
    account_class IN ('ASSET', 'LIABILITY', 'SUSPENSE')
  ),
  normal_side TEXT NOT NULL CHECK (normal_side IN ('DEBIT', 'CREDIT')),
  definition_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    definition_sha256 ~ '^[a-f0-9]{64}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT universal_v1_ledger_account_exact_shape_v1 CHECK (
    (account_code = 'PROVIDER_CLEARING_ASSET'
      AND account_class = 'ASSET' AND normal_side = 'DEBIT')
    OR (account_code = 'CASH_CONTROL_ASSET'
      AND account_class = 'ASSET' AND normal_side = 'DEBIT')
    OR (account_code = 'CUSTOMER_HELD_LIABILITY'
      AND account_class = 'LIABILITY' AND normal_side = 'CREDIT')
    OR (account_code = 'PROVIDER_PAYABLE_LIABILITY'
      AND account_class = 'LIABILITY' AND normal_side = 'CREDIT')
    OR (account_code = 'PAYOUT_CLEARING_LIABILITY'
      AND account_class = 'LIABILITY' AND normal_side = 'CREDIT')
    OR (account_code = 'BANK_IN_TRANSIT_LIABILITY'
      AND account_class = 'LIABILITY' AND normal_side = 'CREDIT')
    OR (account_code = 'SUSPENSE_UNALLOCATED'
      AND account_class = 'SUSPENSE' AND normal_side = 'CREDIT')
  )
);

INSERT INTO public.universal_v1_ledger_accounts_v1 (
  account_code, account_class, normal_side, definition_sha256
)
SELECT account_code,
       account_class,
       normal_side,
       encode(
         digest(
           'HUSTLEXP_UNIVERSAL_V1_LEDGER_ACCOUNT_V1:' ||
           account_code || ':' || account_class || ':' || normal_side,
           'sha256'
         ),
         'hex'
       )
  FROM (VALUES
    ('PROVIDER_CLEARING_ASSET', 'ASSET', 'DEBIT'),
    ('CASH_CONTROL_ASSET', 'ASSET', 'DEBIT'),
    ('CUSTOMER_HELD_LIABILITY', 'LIABILITY', 'CREDIT'),
    ('PROVIDER_PAYABLE_LIABILITY', 'LIABILITY', 'CREDIT'),
    ('PAYOUT_CLEARING_LIABILITY', 'LIABILITY', 'CREDIT'),
    ('BANK_IN_TRANSIT_LIABILITY', 'LIABILITY', 'CREDIT'),
    ('SUSPENSE_UNALLOCATED', 'SUSPENSE', 'CREDIT')
  ) AS account(account_code, account_class, normal_side)
ON CONFLICT (account_code) DO NOTHING;

DO $$
DECLARE
  exact_account_count INTEGER;
BEGIN
  SELECT count(*)::INTEGER
    INTO exact_account_count
    FROM public.universal_v1_ledger_accounts_v1 account
   WHERE account.definition_sha256 = encode(
           digest(
             'HUSTLEXP_UNIVERSAL_V1_LEDGER_ACCOUNT_V1:' ||
             account.account_code || ':' || account.account_class || ':' || account.normal_side,
             'sha256'
           ),
           'hex'
         );
  IF exact_account_count <> 7
     OR (SELECT count(*) FROM public.universal_v1_ledger_accounts_v1) <> 7 THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-1: closed chart of accounts is missing or drifted'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Literal immutable posting policy. The amount basis is database-derived from
-- the intent. RESIDUAL means customer_amount_cents - provider_amount_cents and
-- the posting is omitted when that exact residual is zero.
CREATE OR REPLACE FUNCTION public.universal_v1_double_entry_posting_matrix_v1(
  checked_terminal_path TEXT
)
RETURNS TABLE (
  terminal_path TEXT,
  transaction_kind TEXT,
  transaction_ordinal SMALLINT,
  posting_ordinal SMALLINT,
  posting_side TEXT,
  account_code TEXT,
  amount_basis TEXT
)
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT matrix.terminal_path,
         matrix.transaction_kind,
         matrix.transaction_ordinal,
         matrix.posting_ordinal,
         matrix.posting_side,
         matrix.account_code,
         matrix.amount_basis
    FROM (VALUES
      ('SETTLED'::TEXT, 'CAPTURE', 1::SMALLINT, 1::SMALLINT,
        'DEBIT'::TEXT, 'PROVIDER_CLEARING_ASSET'::TEXT, 'CUSTOMER'::TEXT),
      ('SETTLED'::TEXT, 'CAPTURE', 1::SMALLINT, 2::SMALLINT,
        'CREDIT'::TEXT, 'CUSTOMER_HELD_LIABILITY'::TEXT, 'CUSTOMER'::TEXT),
      ('SETTLED'::TEXT, 'SETTLEMENT', 2::SMALLINT, 1::SMALLINT,
        'DEBIT'::TEXT, 'CASH_CONTROL_ASSET'::TEXT, 'CUSTOMER'::TEXT),
      ('SETTLED'::TEXT, 'SETTLEMENT', 2::SMALLINT, 2::SMALLINT,
        'CREDIT'::TEXT, 'PROVIDER_CLEARING_ASSET'::TEXT, 'CUSTOMER'::TEXT),
      ('SETTLED'::TEXT, 'FUNDING', 3::SMALLINT, 1::SMALLINT,
        'DEBIT'::TEXT, 'CUSTOMER_HELD_LIABILITY'::TEXT, 'CUSTOMER'::TEXT),
      ('SETTLED'::TEXT, 'FUNDING', 3::SMALLINT, 2::SMALLINT,
        'CREDIT'::TEXT, 'PROVIDER_PAYABLE_LIABILITY'::TEXT, 'PROVIDER'::TEXT),
      ('SETTLED'::TEXT, 'FUNDING', 3::SMALLINT, 3::SMALLINT,
        'CREDIT'::TEXT, 'SUSPENSE_UNALLOCATED'::TEXT, 'RESIDUAL'::TEXT),
      ('SETTLED'::TEXT, 'PROVIDER_RELEASE', 4::SMALLINT, 1::SMALLINT,
        'DEBIT'::TEXT, 'PROVIDER_PAYABLE_LIABILITY'::TEXT, 'PROVIDER'::TEXT),
      ('SETTLED'::TEXT, 'PROVIDER_RELEASE', 4::SMALLINT, 2::SMALLINT,
        'CREDIT'::TEXT, 'PAYOUT_CLEARING_LIABILITY'::TEXT, 'PROVIDER'::TEXT),
      ('SETTLED'::TEXT, 'PAYOUT', 5::SMALLINT, 1::SMALLINT,
        'DEBIT'::TEXT, 'PAYOUT_CLEARING_LIABILITY'::TEXT, 'PROVIDER'::TEXT),
      ('SETTLED'::TEXT, 'PAYOUT', 5::SMALLINT, 2::SMALLINT,
        'CREDIT'::TEXT, 'BANK_IN_TRANSIT_LIABILITY'::TEXT, 'PROVIDER'::TEXT),
      ('SETTLED'::TEXT, 'BANK_SETTLEMENT', 6::SMALLINT, 1::SMALLINT,
        'DEBIT'::TEXT, 'BANK_IN_TRANSIT_LIABILITY'::TEXT, 'PROVIDER'::TEXT),
      ('SETTLED'::TEXT, 'BANK_SETTLEMENT', 6::SMALLINT, 2::SMALLINT,
        'CREDIT'::TEXT, 'CASH_CONTROL_ASSET'::TEXT, 'PROVIDER'::TEXT),
      ('FULL_REFUND'::TEXT, 'CAPTURE', 1::SMALLINT, 1::SMALLINT,
        'DEBIT'::TEXT, 'PROVIDER_CLEARING_ASSET'::TEXT, 'CUSTOMER'::TEXT),
      ('FULL_REFUND'::TEXT, 'CAPTURE', 1::SMALLINT, 2::SMALLINT,
        'CREDIT'::TEXT, 'CUSTOMER_HELD_LIABILITY'::TEXT, 'CUSTOMER'::TEXT),
      ('FULL_REFUND'::TEXT, 'REFUND', 2::SMALLINT, 1::SMALLINT,
        'DEBIT'::TEXT, 'CUSTOMER_HELD_LIABILITY'::TEXT, 'CUSTOMER'::TEXT),
      ('FULL_REFUND'::TEXT, 'REFUND', 2::SMALLINT, 2::SMALLINT,
        'CREDIT'::TEXT, 'PROVIDER_CLEARING_ASSET'::TEXT, 'CUSTOMER'::TEXT)
    ) AS matrix(
      terminal_path, transaction_kind, transaction_ordinal,
      posting_ordinal, posting_side, account_code, amount_basis
    )
   WHERE matrix.terminal_path = checked_terminal_path
   ORDER BY matrix.transaction_ordinal, matrix.posting_ordinal;
$$;

CREATE TABLE IF NOT EXISTS public.universal_v1_ledger_transactions_v1 (
  ledger_transaction_id UUID PRIMARY KEY,
  reconciliation_bridge_id UUID NOT NULL,
  terminal_intent_id UUID NOT NULL,
  reconciliation_fact_id UUID NOT NULL
    REFERENCES public.task_reconciliation_facts(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL
    REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  terminal_path TEXT NOT NULL CHECK (terminal_path IN ('SETTLED', 'FULL_REFUND')),
  transaction_kind TEXT NOT NULL CHECK (transaction_kind IN (
    'CAPTURE', 'SETTLEMENT', 'FUNDING', 'PROVIDER_RELEASE',
    'PAYOUT', 'BANK_SETTLEMENT', 'REFUND'
  )),
  transaction_ordinal SMALLINT NOT NULL CHECK (
    transaction_ordinal BETWEEN 1 AND 6
  ),
  financial_event_id UUID NOT NULL UNIQUE
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  event_amount_cents BIGINT NOT NULL CHECK (
    event_amount_cents BETWEEN 1 AND 9007199254740991
  ),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  bridge_authority_chain_sha256 CHAR(64) NOT NULL CHECK (
    bridge_authority_chain_sha256 ~ '^[a-f0-9]{64}$'
  ),
  intent_authority_context_sha256 CHAR(64) NOT NULL CHECK (
    intent_authority_context_sha256 ~ '^[a-f0-9]{64}$'
  ),
  transaction_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    transaction_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (reconciliation_bridge_id, transaction_kind),
  UNIQUE (reconciliation_fact_id, transaction_kind),
  UNIQUE (terminal_intent_id, transaction_kind),
  UNIQUE (ledger_transaction_id, transaction_kind, currency),
  CONSTRAINT universal_v1_ledger_terminal_path_kind_v1 CHECK (
    (
      terminal_path = 'SETTLED'
      AND transaction_kind IN (
        'CAPTURE', 'SETTLEMENT', 'FUNDING', 'PROVIDER_RELEASE',
        'PAYOUT', 'BANK_SETTLEMENT'
      )
    )
    OR (
      terminal_path = 'FULL_REFUND'
      AND transaction_kind IN ('CAPTURE', 'REFUND')
    )
  )
);

CREATE TABLE IF NOT EXISTS public.universal_v1_ledger_postings_v1 (
  ledger_posting_id UUID PRIMARY KEY,
  ledger_transaction_id UUID NOT NULL,
  transaction_kind TEXT NOT NULL,
  posting_ordinal SMALLINT NOT NULL CHECK (posting_ordinal BETWEEN 1 AND 3),
  posting_side TEXT NOT NULL CHECK (posting_side IN ('DEBIT', 'CREDIT')),
  account_code TEXT NOT NULL
    REFERENCES public.universal_v1_ledger_accounts_v1(account_code) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (
    amount_cents BETWEEN 1 AND 9007199254740991
  ),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  posting_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    posting_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (ledger_transaction_id, posting_ordinal),
  FOREIGN KEY (ledger_transaction_id, transaction_kind, currency)
    REFERENCES public.universal_v1_ledger_transactions_v1(
      ledger_transaction_id, transaction_kind, currency
    ) ON DELETE RESTRICT,
  CONSTRAINT universal_v1_ledger_posting_kind_account_matrix_v1 CHECK (
    (transaction_kind, posting_ordinal, posting_side, account_code) IN (
      ('CAPTURE', 1, 'DEBIT', 'PROVIDER_CLEARING_ASSET'),
      ('CAPTURE', 2, 'CREDIT', 'CUSTOMER_HELD_LIABILITY'),
      ('SETTLEMENT', 1, 'DEBIT', 'CASH_CONTROL_ASSET'),
      ('SETTLEMENT', 2, 'CREDIT', 'PROVIDER_CLEARING_ASSET'),
      ('FUNDING', 1, 'DEBIT', 'CUSTOMER_HELD_LIABILITY'),
      ('FUNDING', 2, 'CREDIT', 'PROVIDER_PAYABLE_LIABILITY'),
      ('FUNDING', 3, 'CREDIT', 'SUSPENSE_UNALLOCATED'),
      ('PROVIDER_RELEASE', 1, 'DEBIT', 'PROVIDER_PAYABLE_LIABILITY'),
      ('PROVIDER_RELEASE', 2, 'CREDIT', 'PAYOUT_CLEARING_LIABILITY'),
      ('PAYOUT', 1, 'DEBIT', 'PAYOUT_CLEARING_LIABILITY'),
      ('PAYOUT', 2, 'CREDIT', 'BANK_IN_TRANSIT_LIABILITY'),
      ('BANK_SETTLEMENT', 1, 'DEBIT', 'BANK_IN_TRANSIT_LIABILITY'),
      ('BANK_SETTLEMENT', 2, 'CREDIT', 'CASH_CONTROL_ASSET'),
      ('REFUND', 1, 'DEBIT', 'CUSTOMER_HELD_LIABILITY'),
      ('REFUND', 2, 'CREDIT', 'PROVIDER_CLEARING_ASSET')
    )
  )
);

CREATE TABLE IF NOT EXISTS public.universal_v1_ledger_certifications_v1 (
  ledger_certification_id UUID PRIMARY KEY,
  reconciliation_bridge_id UUID NOT NULL UNIQUE,
  terminal_intent_id UUID NOT NULL UNIQUE,
  reconciliation_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.task_reconciliation_facts(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL UNIQUE
    REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  terminal_path TEXT NOT NULL CHECK (terminal_path IN ('SETTLED', 'FULL_REFUND')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  certified_transaction_count SMALLINT NOT NULL CHECK (
    certified_transaction_count IN (2, 6)
  ),
  certified_posting_count SMALLINT NOT NULL CHECK (
    certified_posting_count BETWEEN 4 AND 13
  ),
  debit_total_cents BIGINT NOT NULL CHECK (debit_total_cents > 0),
  credit_total_cents BIGINT NOT NULL CHECK (
    credit_total_cents = debit_total_cents
  ),
  ledger_sha256 CHAR(64) NOT NULL UNIQUE CHECK (ledger_sha256 ~ '^[a-f0-9]{64}$'),
  certification_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    certification_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  certified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT universal_v1_ledger_certification_path_count_v1 CHECK (
    (terminal_path = 'SETTLED' AND certified_transaction_count = 6
      AND certified_posting_count BETWEEN 12 AND 13)
    OR
    (terminal_path = 'FULL_REFUND' AND certified_transaction_count = 2
      AND certified_posting_count = 4)
  )
);

-- Deterministic UUID-v4 projection used only for immutable ledger identities.
CREATE OR REPLACE FUNCTION public.universal_v1_double_entry_uuid_v1(seed TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  hexadecimal TEXT;
  variant_nibble TEXT;
BEGIN
  hexadecimal := substr(encode(digest(seed, 'sha256'), 'hex'), 1, 32);
  variant_nibble := CASE substr(hexadecimal, 17, 1)
    WHEN '0' THEN '8' WHEN '1' THEN '9' WHEN '2' THEN 'a' WHEN '3' THEN 'b'
    WHEN '4' THEN '8' WHEN '5' THEN '9' WHEN '6' THEN 'a' WHEN '7' THEN 'b'
    WHEN '8' THEN '8' WHEN '9' THEN '9' WHEN 'a' THEN 'a' WHEN 'b' THEN 'b'
    WHEN 'c' THEN '8' WHEN 'd' THEN '9' WHEN 'e' THEN 'a' WHEN 'f' THEN 'b'
  END;
  hexadecimal := overlay(hexadecimal placing '4' from 13 for 1);
  hexadecimal := overlay(hexadecimal placing variant_nibble from 17 for 1);
  RETURN (
    substr(hexadecimal, 1, 8) || '-' || substr(hexadecimal, 9, 4) || '-' ||
    substr(hexadecimal, 13, 4) || '-' || substr(hexadecimal, 17, 4) || '-' ||
    substr(hexadecimal, 21, 12)
  )::UUID;
END;
$$;

-- Return the only postings that may exist for one exact fake terminal
-- reconciliation. Fake relations are reached by dynamic SQL so this function
-- can be installed in the production engine before those nonproduction-only
-- relations exist.
CREATE OR REPLACE FUNCTION public.universal_v1_expected_double_entry_postings_v1(
  checked_reconciliation_fact_id UUID
)
RETURNS TABLE (
  ledger_transaction_id UUID,
  reconciliation_bridge_id UUID,
  terminal_intent_id UUID,
  reconciliation_fact_id UUID,
  work_order_id UUID,
  terminal_path TEXT,
  transaction_kind TEXT,
  transaction_ordinal SMALLINT,
  financial_event_id UUID,
  event_amount_cents BIGINT,
  currency CHAR(3),
  bridge_authority_chain_sha256 CHAR(64),
  intent_authority_context_sha256 CHAR(64),
  event_occurred_at TIMESTAMPTZ,
  posting_ordinal SMALLINT,
  posting_side TEXT,
  account_code TEXT,
  posting_amount_cents BIGINT
)
LANGUAGE plpgsql
VOLATILE
STRICT
PARALLEL UNSAFE
AS $$
DECLARE
  authority RECORD;
  reconciliation public.task_reconciliation_facts%ROWTYPE;
  event public.task_financial_security_events%ROWTYPE;
  matrix RECORD;
  event_ids UUID[];
  event_kinds TEXT[];
  transaction_kinds TEXT[];
  operation_labels TEXT[];
  event_amounts BIGINT[];
  predecessor_event_ids UUID[];
  current_transaction_id UUID;
  current_transaction_kind TEXT;
  current_transaction_ordinal SMALLINT;
  current_event_id UUID;
  current_event_amount BIGINT;
  current_posting_amount BIGINT;
  residual_amount_cents BIGINT;
  expected_terminal_event_id UUID;
  expected_operation_id UUID;
  ordinal INTEGER;
BEGIN
  IF to_regclass('public.universal_v1_fake_reconciliation_bridges') IS NULL
     OR to_regclass('public.universal_v1_fake_terminal_lifecycle_intents') IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO reconciliation
    FROM public.task_reconciliation_facts
   WHERE id = checked_reconciliation_fact_id
   FOR SHARE;
  IF reconciliation.id IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $authority_query$
    SELECT bridge.reconciliation_bridge_id,
           bridge.reconciliation_fact_id AS bridge_reconciliation_fact_id,
           bridge.terminal_intent_id AS bridge_terminal_intent_id,
           bridge.terminal_lifecycle_event_id,
           bridge.provider_state,
           bridge.reconciliation_version AS bridge_reconciliation_version,
           bridge.reconciliation_identity_sha256,
           bridge.authority_chain_sha256,
           intent.terminal_intent_id,
           intent.terminal_path,
           intent.work_order_id,
           intent.task_draft_id,
           intent.task_id,
           intent.scope_version_id,
           intent.eligibility_decision_id,
           intent.starting_financial_event_id,
           intent.starting_financial_version,
           intent.starting_reconciliation_version,
           intent.completion_fact_id,
           intent.customer_amount_cents,
           intent.provider_amount_cents,
           intent.currency,
           intent.idempotency_key,
           intent.requested_by,
           intent.authority_context_sha256
      FROM public.universal_v1_fake_reconciliation_bridges bridge
      JOIN public.universal_v1_fake_terminal_lifecycle_intents intent
        ON bridge.terminal_intent_id = intent.terminal_intent_id
     WHERE bridge.reconciliation_fact_id = $1
  $authority_query$
  INTO authority
  USING checked_reconciliation_fact_id;

  IF authority.reconciliation_bridge_id IS NULL THEN
    RETURN;
  END IF;

  IF authority.bridge_reconciliation_fact_id IS DISTINCT FROM reconciliation.id
     OR authority.bridge_terminal_intent_id IS DISTINCT FROM authority.terminal_intent_id
     OR authority.work_order_id IS DISTINCT FROM reconciliation.work_order_id
     OR authority.bridge_reconciliation_version IS DISTINCT FROM reconciliation.reconciliation_version
     OR reconciliation.reconciliation_version
          <> authority.starting_reconciliation_version + 1
     OR reconciliation.expected_version <> authority.starting_reconciliation_version
     OR reconciliation.recorded_by IS DISTINCT FROM authority.requested_by
     OR reconciliation.ledger_state <> 'MATCHED'
     OR cardinality(reconciliation.mismatch_codes) <> 0
     OR authority.provider_state <> 'MATCHED'
     OR reconciliation.currency IS DISTINCT FROM authority.currency
     OR authority.currency !~ '^[A-Z]{3}$'
     OR authority.customer_amount_cents NOT BETWEEN 1 AND 9007199254740991
     OR authority.provider_amount_cents NOT BETWEEN 0 AND authority.customer_amount_cents
     OR authority.authority_chain_sha256 !~ '^[a-f0-9]{64}$'
     OR authority.authority_context_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-10: ledger authority does not match the exact immutable bridge, intent, and reconciliation'
      USING ERRCODE = 'P0001';
  END IF;

  residual_amount_cents := authority.customer_amount_cents - authority.provider_amount_cents;

  IF authority.terminal_path = 'SETTLED' THEN
    IF reconciliation.reconciliation_state <> 'MATCHED'
       OR reconciliation.customer_ledger_amount_cents <> authority.customer_amount_cents
       OR reconciliation.provider_ledger_amount_cents <> authority.provider_amount_cents
       OR reconciliation.capture_state <> 'CAPTURED'
       OR reconciliation.settlement_state <> 'SETTLED'
       OR reconciliation.funding_state <> 'FUNDED'
       OR reconciliation.provider_release_state <> 'RELEASED'
       OR reconciliation.payout_state <> 'PAID'
       OR reconciliation.bank_settlement_state <> 'SETTLED'
       OR reconciliation.refund_state <> 'NOT_APPLICABLE'
       OR reconciliation.reversal_state <> 'NOT_APPLICABLE'
       OR reconciliation.void_state <> 'NOT_APPLICABLE'
       OR authority.provider_amount_cents < 1 THEN
      RAISE EXCEPTION 'HXUV1-LEDGER-11: SETTLED ledger requires the exact complete matched lifecycle'
        USING ERRCODE = 'P0001';
    END IF;
    event_ids := ARRAY[
      reconciliation.capture_event_id,
      reconciliation.settlement_event_id,
      reconciliation.funding_event_id,
      reconciliation.provider_release_event_id,
      reconciliation.payout_event_id,
      reconciliation.bank_settlement_event_id
    ];
    event_kinds := ARRAY[
      'CAPTURED', 'SETTLEMENT_OBSERVED', 'FUNDING_OBSERVED',
      'PROVIDER_RELEASED', 'PAYOUT_OBSERVED', 'BANK_SETTLEMENT_OBSERVED'
    ];
    transaction_kinds := ARRAY[
      'CAPTURE', 'SETTLEMENT', 'FUNDING',
      'PROVIDER_RELEASE', 'PAYOUT', 'BANK_SETTLEMENT'
    ];
    operation_labels := ARRAY[
      'capture', 'settle', 'fund', 'provider-release', 'payout', 'bank-settlement'
    ];
    event_amounts := ARRAY[
      authority.customer_amount_cents,
      authority.customer_amount_cents,
      authority.customer_amount_cents,
      authority.provider_amount_cents,
      authority.provider_amount_cents,
      authority.provider_amount_cents
    ];
    predecessor_event_ids := ARRAY[
      authority.starting_financial_event_id,
      reconciliation.capture_event_id,
      reconciliation.settlement_event_id,
      reconciliation.funding_event_id,
      reconciliation.provider_release_event_id,
      reconciliation.payout_event_id
    ];
    expected_terminal_event_id := reconciliation.bank_settlement_event_id;
  ELSIF authority.terminal_path = 'FULL_REFUND' THEN
    IF reconciliation.reconciliation_state <> 'CLOSED'
       OR reconciliation.customer_ledger_amount_cents <> 0
       OR reconciliation.provider_ledger_amount_cents <> 0
       OR reconciliation.capture_state <> 'CAPTURED'
       OR reconciliation.refund_state <> 'REFUNDED'
       OR reconciliation.settlement_state <> 'NOT_APPLICABLE'
       OR reconciliation.funding_state <> 'NOT_APPLICABLE'
       OR reconciliation.provider_release_state <> 'NOT_APPLICABLE'
       OR reconciliation.payout_state <> 'NOT_APPLICABLE'
       OR reconciliation.bank_settlement_state <> 'NOT_APPLICABLE'
       OR reconciliation.reversal_state <> 'NOT_APPLICABLE'
       OR reconciliation.void_state <> 'NOT_APPLICABLE' THEN
      RAISE EXCEPTION 'HXUV1-LEDGER-12: FULL_REFUND ledger requires the exact capture and full-refund lifecycle'
        USING ERRCODE = 'P0001';
    END IF;
    event_ids := ARRAY[reconciliation.capture_event_id, reconciliation.refund_event_id];
    event_kinds := ARRAY['CAPTURED', 'REFUNDED'];
    transaction_kinds := ARRAY['CAPTURE', 'REFUND'];
    operation_labels := ARRAY['capture', 'full-refund'];
    event_amounts := ARRAY[authority.customer_amount_cents, authority.customer_amount_cents];
    predecessor_event_ids := ARRAY[
      authority.starting_financial_event_id,
      reconciliation.capture_event_id
    ];
    expected_terminal_event_id := reconciliation.refund_event_id;
  ELSE
    RAISE EXCEPTION 'HXUV1-LEDGER-13: terminal path is outside the closed ledger policy'
      USING ERRCODE = 'P0001';
  END IF;

  IF authority.terminal_lifecycle_event_id IS DISTINCT FROM expected_terminal_event_id THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-14: bridge does not bind the exact terminal lifecycle event'
      USING ERRCODE = 'P0001';
  END IF;

  FOR ordinal IN 1..cardinality(event_ids)
  LOOP
    current_event_id := event_ids[ordinal];
    current_event_amount := event_amounts[ordinal];
    current_transaction_kind := transaction_kinds[ordinal];
    current_transaction_ordinal := ordinal::SMALLINT;
    expected_operation_id := public.universal_v1_double_entry_uuid_v1(
      authority.idempotency_key || ':' || operation_labels[ordinal]
    );

    SELECT * INTO event
      FROM public.task_financial_security_events
     WHERE id = current_event_id
     FOR SHARE;
    IF event.id IS NULL
       OR event.task_draft_id IS DISTINCT FROM authority.task_draft_id
       OR event.task_id IS DISTINCT FROM authority.task_id
       OR event.eligibility_decision_id IS DISTINCT FROM authority.eligibility_decision_id
       OR event.scope_version_id IS DISTINCT FROM authority.scope_version_id
       OR event.event_kind IS DISTINCT FROM event_kinds[ordinal]
       OR event.status <> 'SUCCEEDED'
       OR event.operation_id IS DISTINCT FROM expected_operation_id::TEXT
       OR event.expected_version <> authority.starting_financial_version + ordinal
       OR event.provider_kind <> 'FAKE'
       OR event.amount_cents IS DISTINCT FROM current_event_amount
       OR event.currency IS DISTINCT FROM authority.currency
       OR event.predecessor_event_id IS DISTINCT FROM predecessor_event_ids[ordinal]
       OR (ordinal = 1 AND event.completion_fact_id IS DISTINCT FROM authority.completion_fact_id)
       OR (ordinal > 1 AND event.completion_fact_id IS NOT NULL) THEN
      RAISE EXCEPTION 'HXUV1-LEDGER-15: lifecycle event is not the exact successful fake terminal step at ordinal %', ordinal
        USING ERRCODE = 'P0001';
    END IF;

    current_transaction_id := public.universal_v1_double_entry_uuid_v1(
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_TRANSACTION_V1:' ||
      authority.reconciliation_bridge_id::TEXT || ':' ||
      current_transaction_kind || ':' || current_event_id::TEXT
    );

    FOR matrix IN
      SELECT *
        FROM public.universal_v1_double_entry_posting_matrix_v1(
          authority.terminal_path
        ) matrix_row
       WHERE matrix_row.transaction_kind = current_transaction_kind
       ORDER BY matrix_row.posting_ordinal
    LOOP
      IF matrix.amount_basis = 'RESIDUAL' THEN
        IF residual_amount_cents > 0 THEN
          current_posting_amount := residual_amount_cents;
        ELSE
          CONTINUE;
        END IF;
      ELSE
        current_posting_amount := CASE matrix.amount_basis
          WHEN 'CUSTOMER' THEN authority.customer_amount_cents
          WHEN 'PROVIDER' THEN authority.provider_amount_cents
        END;
      END IF;
      IF current_posting_amount NOT BETWEEN 1 AND 9007199254740991 THEN
        RAISE EXCEPTION 'HXUV1-LEDGER-16: derived posting amount is outside exact positive-cent bounds'
          USING ERRCODE = 'P0001';
      END IF;

      ledger_transaction_id := current_transaction_id;
      reconciliation_bridge_id := authority.reconciliation_bridge_id;
      terminal_intent_id := authority.terminal_intent_id;
      reconciliation_fact_id := reconciliation.id;
      work_order_id := authority.work_order_id;
      terminal_path := authority.terminal_path;
      transaction_kind := current_transaction_kind;
      transaction_ordinal := current_transaction_ordinal;
      financial_event_id := current_event_id;
      event_amount_cents := current_event_amount;
      currency := authority.currency;
      bridge_authority_chain_sha256 := authority.authority_chain_sha256;
      intent_authority_context_sha256 := authority.authority_context_sha256;
      event_occurred_at := event.occurred_at;
      posting_ordinal := matrix.posting_ordinal;
      posting_side := matrix.posting_side;
      account_code := matrix.account_code;
      posting_amount_cents := current_posting_amount;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_ledger_transaction_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected RECORD;
  expected_identity CHAR(64);
BEGIN
  SELECT * INTO expected
    FROM public.universal_v1_expected_double_entry_postings_v1(
      NEW.reconciliation_fact_id
    ) expected_posting
   WHERE expected_posting.ledger_transaction_id = NEW.ledger_transaction_id
     AND expected_posting.transaction_kind = NEW.transaction_kind
   ORDER BY expected_posting.posting_ordinal
   LIMIT 1;
  IF expected.ledger_transaction_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-20: ledger transaction lacks exact bridge, intent, and lifecycle authority'
      USING ERRCODE = 'P0001';
  END IF;

  expected_identity := encode(
    digest(
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_TRANSACTION_V1:' ||
      expected.ledger_transaction_id::TEXT || ':' ||
      expected.reconciliation_bridge_id::TEXT || ':' ||
      expected.terminal_intent_id::TEXT || ':' ||
      expected.reconciliation_fact_id::TEXT || ':' ||
      expected.work_order_id::TEXT || ':' || expected.terminal_path || ':' ||
      expected.transaction_kind || ':' || expected.transaction_ordinal::TEXT || ':' ||
      expected.financial_event_id::TEXT || ':' || expected.event_amount_cents::TEXT || ':' ||
      expected.currency || ':' || expected.bridge_authority_chain_sha256 || ':' ||
      expected.intent_authority_context_sha256,
      'sha256'
    ),
    'hex'
  );

  IF NEW.reconciliation_bridge_id IS DISTINCT FROM expected.reconciliation_bridge_id
     OR NEW.terminal_intent_id IS DISTINCT FROM expected.terminal_intent_id
     OR NEW.reconciliation_fact_id IS DISTINCT FROM expected.reconciliation_fact_id
     OR NEW.work_order_id IS DISTINCT FROM expected.work_order_id
     OR NEW.terminal_path IS DISTINCT FROM expected.terminal_path
     OR NEW.transaction_kind IS DISTINCT FROM expected.transaction_kind
     OR NEW.transaction_ordinal IS DISTINCT FROM expected.transaction_ordinal
     OR NEW.financial_event_id IS DISTINCT FROM expected.financial_event_id
     OR NEW.event_amount_cents IS DISTINCT FROM expected.event_amount_cents
     OR NEW.currency IS DISTINCT FROM expected.currency
     OR NEW.bridge_authority_chain_sha256 IS DISTINCT FROM expected.bridge_authority_chain_sha256
     OR NEW.intent_authority_context_sha256 IS DISTINCT FROM expected.intent_authority_context_sha256
     OR NEW.transaction_identity_sha256 IS DISTINCT FROM expected_identity
     OR NEW.recorded_at IS DISTINCT FROM expected.event_occurred_at THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-21: ledger transaction fields must equal their database-derived values'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_ledger_posting_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  transaction_record public.universal_v1_ledger_transactions_v1%ROWTYPE;
  expected RECORD;
  expected_posting_id UUID;
  expected_identity CHAR(64);
BEGIN
  SELECT * INTO transaction_record
    FROM public.universal_v1_ledger_transactions_v1
   WHERE ledger_transaction_id = NEW.ledger_transaction_id
   FOR SHARE;
  SELECT * INTO expected
    FROM public.universal_v1_expected_double_entry_postings_v1(
      transaction_record.reconciliation_fact_id
    ) expected_posting
   WHERE expected_posting.ledger_transaction_id = NEW.ledger_transaction_id
     AND expected_posting.posting_ordinal = NEW.posting_ordinal;
  IF transaction_record.ledger_transaction_id IS NULL
     OR expected.ledger_transaction_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-22: ledger posting lacks an exact derived transaction and matrix row'
      USING ERRCODE = 'P0001';
  END IF;

  expected_posting_id := public.universal_v1_double_entry_uuid_v1(
    'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_POSTING_V1:' ||
    expected.ledger_transaction_id::TEXT || ':' || expected.posting_ordinal::TEXT
  );
  expected_identity := encode(
    digest(
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_POSTING_V1:' ||
      expected_posting_id::TEXT || ':' || expected.ledger_transaction_id::TEXT || ':' ||
      expected.transaction_kind || ':' || expected.posting_ordinal::TEXT || ':' ||
      expected.posting_side || ':' || expected.account_code || ':' ||
      expected.posting_amount_cents::TEXT || ':' || expected.currency,
      'sha256'
    ),
    'hex'
  );

  IF NEW.ledger_posting_id IS DISTINCT FROM expected_posting_id
     OR NEW.transaction_kind IS DISTINCT FROM expected.transaction_kind
     OR NEW.posting_side IS DISTINCT FROM expected.posting_side
     OR NEW.account_code IS DISTINCT FROM expected.account_code
     OR NEW.amount_cents IS DISTINCT FROM expected.posting_amount_cents
     OR NEW.currency IS DISTINCT FROM expected.currency
     OR NEW.posting_identity_sha256 IS DISTINCT FROM expected_identity
     OR NEW.recorded_at IS DISTINCT FROM expected.event_occurred_at THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-23: ledger posting must equal the exact derived path matrix row'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.certify_universal_v1_double_entry_ledger_v1(
  checked_reconciliation_fact_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  authority RECORD;
  transaction_count INTEGER;
  posting_count INTEGER;
  debit_total_cents BIGINT;
  credit_total_cents BIGINT;
  derived_ledger_sha256 CHAR(64);
  derived_certification_id UUID;
  derived_certification_identity CHAR(64);
  existing public.universal_v1_ledger_certifications_v1%ROWTYPE;
BEGIN
  SELECT * INTO authority
    FROM public.universal_v1_expected_double_entry_postings_v1(
      checked_reconciliation_fact_id
    ) expected
   ORDER BY expected.transaction_ordinal, expected.posting_ordinal
   LIMIT 1;
  IF authority.reconciliation_fact_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_ledger_transactions_v1 transaction
     WHERE transaction.reconciliation_fact_id = checked_reconciliation_fact_id
       AND transaction.transaction_identity_sha256 IS DISTINCT FROM encode(
         digest(
           'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_TRANSACTION_V1:' ||
           transaction.ledger_transaction_id::TEXT || ':' ||
           transaction.reconciliation_bridge_id::TEXT || ':' ||
           transaction.terminal_intent_id::TEXT || ':' ||
           transaction.reconciliation_fact_id::TEXT || ':' ||
           transaction.work_order_id::TEXT || ':' || transaction.terminal_path || ':' ||
           transaction.transaction_kind || ':' || transaction.transaction_ordinal::TEXT || ':' ||
           transaction.financial_event_id::TEXT || ':' || transaction.event_amount_cents::TEXT || ':' ||
           transaction.currency || ':' || transaction.bridge_authority_chain_sha256 || ':' ||
           transaction.intent_authority_context_sha256,
           'sha256'
         ),
         'hex'
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.universal_v1_ledger_postings_v1 posting
      JOIN public.universal_v1_ledger_transactions_v1 transaction
        ON transaction.ledger_transaction_id = posting.ledger_transaction_id
     WHERE transaction.reconciliation_fact_id = checked_reconciliation_fact_id
       AND (
         posting.ledger_posting_id IS DISTINCT FROM
           public.universal_v1_double_entry_uuid_v1(
             'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_POSTING_V1:' ||
             posting.ledger_transaction_id::TEXT || ':' || posting.posting_ordinal::TEXT
           )
         OR posting.posting_identity_sha256 IS DISTINCT FROM encode(
           digest(
             'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_POSTING_V1:' ||
             posting.ledger_posting_id::TEXT || ':' ||
             posting.ledger_transaction_id::TEXT || ':' || posting.transaction_kind || ':' ||
             posting.posting_ordinal::TEXT || ':' || posting.posting_side || ':' ||
             posting.account_code || ':' || posting.amount_cents::TEXT || ':' || posting.currency,
             'sha256'
           ),
           'hex'
         )
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-29: ledger contains a non-deterministic transaction or posting identity'
      USING ERRCODE = 'P0001';
  END IF;

  -- Both EXCEPT ALL directions make missing, duplicate, altered, and extra
  -- transactions or postings equally fatal to certification.
  IF EXISTS (
    WITH expected_transactions AS (
      SELECT DISTINCT expected.ledger_transaction_id,
             expected.reconciliation_bridge_id,
             expected.terminal_intent_id,
             expected.reconciliation_fact_id,
             expected.work_order_id,
             expected.terminal_path,
             expected.transaction_kind,
             expected.transaction_ordinal,
             expected.financial_event_id,
             expected.event_amount_cents,
             expected.currency,
             expected.bridge_authority_chain_sha256,
             expected.intent_authority_context_sha256,
             expected.event_occurred_at
        FROM public.universal_v1_expected_double_entry_postings_v1(
          checked_reconciliation_fact_id
        ) expected
    ),
    actual_transactions AS (
      SELECT transaction.ledger_transaction_id,
             transaction.reconciliation_bridge_id,
             transaction.terminal_intent_id,
             transaction.reconciliation_fact_id,
             transaction.work_order_id,
             transaction.terminal_path,
             transaction.transaction_kind,
             transaction.transaction_ordinal,
             transaction.financial_event_id,
             transaction.event_amount_cents,
             transaction.currency,
             transaction.bridge_authority_chain_sha256,
             transaction.intent_authority_context_sha256,
             transaction.recorded_at
        FROM public.universal_v1_ledger_transactions_v1 transaction
       WHERE transaction.reconciliation_fact_id = checked_reconciliation_fact_id
    )
    SELECT 1 FROM (
      (SELECT * FROM expected_transactions EXCEPT ALL SELECT * FROM actual_transactions)
      UNION ALL
      (SELECT * FROM actual_transactions EXCEPT ALL SELECT * FROM expected_transactions)
    ) difference
  ) THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-30: actual ledger transactions differ from exact derived authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    WITH expected_postings AS (
      SELECT expected.ledger_transaction_id,
             expected.transaction_kind,
             expected.posting_ordinal,
             expected.posting_side,
             expected.account_code,
             expected.posting_amount_cents,
             expected.currency,
             expected.event_occurred_at
        FROM public.universal_v1_expected_double_entry_postings_v1(
          checked_reconciliation_fact_id
        ) expected
    ),
    actual_postings AS (
      SELECT posting.ledger_transaction_id,
             posting.transaction_kind,
             posting.posting_ordinal,
             posting.posting_side,
             posting.account_code,
             posting.amount_cents,
             posting.currency,
             posting.recorded_at
        FROM public.universal_v1_ledger_postings_v1 posting
        JOIN public.universal_v1_ledger_transactions_v1 transaction
          ON transaction.ledger_transaction_id = posting.ledger_transaction_id
       WHERE transaction.reconciliation_fact_id = checked_reconciliation_fact_id
    )
    SELECT 1 FROM (
      (SELECT * FROM expected_postings EXCEPT ALL SELECT * FROM actual_postings)
      UNION ALL
      (SELECT * FROM actual_postings EXCEPT ALL SELECT * FROM expected_postings)
    ) difference
  ) THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-31: actual ledger postings differ from the closed path matrix'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT transaction.ledger_transaction_id
      FROM public.universal_v1_ledger_transactions_v1 transaction
      JOIN public.universal_v1_ledger_postings_v1 posting
        ON posting.ledger_transaction_id = transaction.ledger_transaction_id
     WHERE transaction.reconciliation_fact_id = checked_reconciliation_fact_id
     GROUP BY transaction.ledger_transaction_id
    HAVING count(*) < 2
        OR count(DISTINCT posting.currency) <> 1
        OR sum(posting.amount_cents) FILTER (WHERE posting_side = 'DEBIT')
             IS DISTINCT FROM
           sum(posting.amount_cents) FILTER (WHERE posting_side = 'CREDIT')
  ) THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-32: each ledger transaction requires one currency, two or more postings, and exact balance'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(DISTINCT transaction.ledger_transaction_id)::INTEGER,
         count(posting.ledger_posting_id)::INTEGER,
         sum(posting.amount_cents) FILTER (WHERE posting.posting_side = 'DEBIT'),
         sum(posting.amount_cents) FILTER (WHERE posting.posting_side = 'CREDIT')
    INTO transaction_count, posting_count, debit_total_cents, credit_total_cents
    FROM public.universal_v1_ledger_transactions_v1 transaction
    JOIN public.universal_v1_ledger_postings_v1 posting
      ON posting.ledger_transaction_id = transaction.ledger_transaction_id
   WHERE transaction.reconciliation_fact_id = checked_reconciliation_fact_id;

  IF debit_total_cents <> credit_total_cents
     OR (authority.terminal_path = 'SETTLED' AND transaction_count <> 6)
     OR (authority.terminal_path = 'FULL_REFUND' AND transaction_count <> 2)
     OR (authority.terminal_path = 'SETTLED' AND posting_count NOT IN (12, 13))
     OR (authority.terminal_path = 'FULL_REFUND' AND posting_count <> 4) THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-33: complete terminal path is not exactly balanced and certified'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT encode(
           digest(
             string_agg(
               transaction.transaction_ordinal::TEXT || ':' ||
               transaction.ledger_transaction_id::TEXT || ':' ||
               transaction.transaction_identity_sha256 || ':' ||
               posting.posting_ordinal::TEXT || ':' ||
               posting.ledger_posting_id::TEXT || ':' ||
               posting.posting_identity_sha256,
               '|' ORDER BY transaction.transaction_ordinal, posting.posting_ordinal
             ),
             'sha256'
           ),
           'hex'
         )
    INTO derived_ledger_sha256
    FROM public.universal_v1_ledger_transactions_v1 transaction
    JOIN public.universal_v1_ledger_postings_v1 posting
      ON posting.ledger_transaction_id = transaction.ledger_transaction_id
   WHERE transaction.reconciliation_fact_id = checked_reconciliation_fact_id;

  derived_certification_id := public.universal_v1_double_entry_uuid_v1(
    'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_CERTIFICATION_V1:' ||
    authority.reconciliation_bridge_id::TEXT || ':' || checked_reconciliation_fact_id::TEXT
  );
  derived_certification_identity := encode(
    digest(
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_CERTIFICATION_V1:' ||
      derived_certification_id::TEXT || ':' ||
      authority.reconciliation_bridge_id::TEXT || ':' ||
      authority.terminal_intent_id::TEXT || ':' || checked_reconciliation_fact_id::TEXT || ':' ||
      authority.work_order_id::TEXT || ':' || authority.terminal_path || ':' ||
      authority.currency || ':' || transaction_count::TEXT || ':' || posting_count::TEXT || ':' ||
      debit_total_cents::TEXT || ':' || credit_total_cents::TEXT || ':' || derived_ledger_sha256,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.universal_v1_ledger_certifications_v1 (
    ledger_certification_id, reconciliation_bridge_id, terminal_intent_id,
    reconciliation_fact_id, work_order_id, terminal_path, currency,
    certified_transaction_count, certified_posting_count,
    debit_total_cents, credit_total_cents, ledger_sha256,
    certification_identity_sha256
  ) VALUES (
    derived_certification_id, authority.reconciliation_bridge_id,
    authority.terminal_intent_id, checked_reconciliation_fact_id,
    authority.work_order_id, authority.terminal_path, authority.currency,
    transaction_count, posting_count, debit_total_cents, credit_total_cents,
    derived_ledger_sha256, derived_certification_identity
  )
  ON CONFLICT (reconciliation_bridge_id) DO NOTHING;

  SELECT * INTO existing
    FROM public.universal_v1_ledger_certifications_v1 certification
   WHERE certification.reconciliation_bridge_id = authority.reconciliation_bridge_id;
  IF existing.ledger_certification_id IS DISTINCT FROM derived_certification_id
     OR existing.terminal_intent_id IS DISTINCT FROM authority.terminal_intent_id
     OR existing.reconciliation_fact_id IS DISTINCT FROM checked_reconciliation_fact_id
     OR existing.work_order_id IS DISTINCT FROM authority.work_order_id
     OR existing.terminal_path IS DISTINCT FROM authority.terminal_path
     OR existing.currency IS DISTINCT FROM authority.currency
     OR existing.certified_transaction_count IS DISTINCT FROM transaction_count
     OR existing.certified_posting_count IS DISTINCT FROM posting_count
     OR existing.debit_total_cents IS DISTINCT FROM debit_total_cents
     OR existing.credit_total_cents IS DISTINCT FROM credit_total_cents
     OR existing.ledger_sha256 IS DISTINCT FROM derived_ledger_sha256
     OR existing.certification_identity_sha256 IS DISTINCT FROM derived_certification_identity THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-34: existing certification conflicts with exact derived ledger'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_ledger_certification_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  authority RECORD;
  transaction_count INTEGER;
  posting_count INTEGER;
  debit_total_cents BIGINT;
  credit_total_cents BIGINT;
  expected_ledger_sha256 CHAR(64);
  expected_certification_id UUID;
  expected_certification_identity CHAR(64);
BEGIN
  SELECT * INTO authority
    FROM public.universal_v1_expected_double_entry_postings_v1(
      NEW.reconciliation_fact_id
    ) expected
   ORDER BY expected.transaction_ordinal, expected.posting_ordinal
   LIMIT 1;
  IF authority.reconciliation_fact_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-35: ledger certification lacks exact terminal authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT transaction.ledger_transaction_id
      FROM public.universal_v1_ledger_transactions_v1 transaction
      JOIN public.universal_v1_ledger_postings_v1 posting
        ON posting.ledger_transaction_id = transaction.ledger_transaction_id
     WHERE transaction.reconciliation_fact_id = NEW.reconciliation_fact_id
     GROUP BY transaction.ledger_transaction_id
    HAVING count(*) < 2
        OR count(DISTINCT posting.currency) <> 1
        OR sum(posting.amount_cents) FILTER (WHERE posting_side = 'DEBIT')
             IS DISTINCT FROM
           sum(posting.amount_cents) FILTER (WHERE posting_side = 'CREDIT')
  ) THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-36: certification requires every exact transaction to balance'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(DISTINCT transaction.ledger_transaction_id)::INTEGER,
         count(posting.ledger_posting_id)::INTEGER,
         sum(posting.amount_cents) FILTER (WHERE posting.posting_side = 'DEBIT'),
         sum(posting.amount_cents) FILTER (WHERE posting.posting_side = 'CREDIT')
    INTO transaction_count, posting_count, debit_total_cents, credit_total_cents
    FROM public.universal_v1_ledger_transactions_v1 transaction
    JOIN public.universal_v1_ledger_postings_v1 posting
      ON posting.ledger_transaction_id = transaction.ledger_transaction_id
   WHERE transaction.reconciliation_fact_id = NEW.reconciliation_fact_id;

  SELECT encode(
           digest(
             string_agg(
               transaction.transaction_ordinal::TEXT || ':' ||
               transaction.ledger_transaction_id::TEXT || ':' ||
               transaction.transaction_identity_sha256 || ':' ||
               posting.posting_ordinal::TEXT || ':' ||
               posting.ledger_posting_id::TEXT || ':' ||
               posting.posting_identity_sha256,
               '|' ORDER BY transaction.transaction_ordinal, posting.posting_ordinal
             ),
             'sha256'
           ),
           'hex'
         )
    INTO expected_ledger_sha256
    FROM public.universal_v1_ledger_transactions_v1 transaction
    JOIN public.universal_v1_ledger_postings_v1 posting
      ON posting.ledger_transaction_id = transaction.ledger_transaction_id
   WHERE transaction.reconciliation_fact_id = NEW.reconciliation_fact_id;

  expected_certification_id := public.universal_v1_double_entry_uuid_v1(
    'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_CERTIFICATION_V1:' ||
    authority.reconciliation_bridge_id::TEXT || ':' || NEW.reconciliation_fact_id::TEXT
  );
  expected_certification_identity := encode(
    digest(
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_CERTIFICATION_V1:' ||
      expected_certification_id::TEXT || ':' ||
      authority.reconciliation_bridge_id::TEXT || ':' ||
      authority.terminal_intent_id::TEXT || ':' || NEW.reconciliation_fact_id::TEXT || ':' ||
      authority.work_order_id::TEXT || ':' || authority.terminal_path || ':' ||
      authority.currency || ':' || transaction_count::TEXT || ':' || posting_count::TEXT || ':' ||
      debit_total_cents::TEXT || ':' || credit_total_cents::TEXT || ':' || expected_ledger_sha256,
      'sha256'
    ),
    'hex'
  );

  IF debit_total_cents IS DISTINCT FROM credit_total_cents
     OR NEW.ledger_certification_id IS DISTINCT FROM expected_certification_id
     OR NEW.reconciliation_bridge_id IS DISTINCT FROM authority.reconciliation_bridge_id
     OR NEW.terminal_intent_id IS DISTINCT FROM authority.terminal_intent_id
     OR NEW.work_order_id IS DISTINCT FROM authority.work_order_id
     OR NEW.terminal_path IS DISTINCT FROM authority.terminal_path
     OR NEW.currency IS DISTINCT FROM authority.currency
     OR NEW.certified_transaction_count IS DISTINCT FROM transaction_count
     OR NEW.certified_posting_count IS DISTINCT FROM posting_count
     OR NEW.debit_total_cents IS DISTINCT FROM debit_total_cents
     OR NEW.credit_total_cents IS DISTINCT FROM credit_total_cents
     OR NEW.ledger_sha256 IS DISTINCT FROM expected_ledger_sha256
     OR NEW.certification_identity_sha256 IS DISTINCT FROM expected_certification_identity THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-37: certification fields must equal the exact complete derived ledger'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_ledger_certification_validate_v1
  ON public.universal_v1_ledger_certifications_v1;
CREATE TRIGGER universal_v1_ledger_certification_validate_v1
BEFORE INSERT ON public.universal_v1_ledger_certifications_v1
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_ledger_certification_v1();

CREATE OR REPLACE FUNCTION public.materialize_universal_v1_double_entry_ledger_v1(
  checked_reconciliation_fact_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  expected_transaction RECORD;
  expected_posting RECORD;
  existing_transaction public.universal_v1_ledger_transactions_v1%ROWTYPE;
  existing_posting public.universal_v1_ledger_postings_v1%ROWTYPE;
  derived_transaction_identity CHAR(64);
  derived_posting_id UUID;
  derived_posting_identity CHAR(64);
  found_authority BOOLEAN := FALSE;
BEGIN
  FOR expected_transaction IN
    SELECT DISTINCT expected.ledger_transaction_id,
           expected.reconciliation_bridge_id,
           expected.terminal_intent_id,
           expected.reconciliation_fact_id,
           expected.work_order_id,
           expected.terminal_path,
           expected.transaction_kind,
           expected.transaction_ordinal,
           expected.financial_event_id,
           expected.event_amount_cents,
           expected.currency,
           expected.bridge_authority_chain_sha256,
           expected.intent_authority_context_sha256,
           expected.event_occurred_at
      FROM public.universal_v1_expected_double_entry_postings_v1(
        checked_reconciliation_fact_id
      ) expected
     ORDER BY expected.transaction_ordinal
  LOOP
    found_authority := TRUE;
    derived_transaction_identity := encode(
      digest(
        'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_TRANSACTION_V1:' ||
        expected_transaction.ledger_transaction_id::TEXT || ':' ||
        expected_transaction.reconciliation_bridge_id::TEXT || ':' ||
        expected_transaction.terminal_intent_id::TEXT || ':' ||
        expected_transaction.reconciliation_fact_id::TEXT || ':' ||
        expected_transaction.work_order_id::TEXT || ':' ||
        expected_transaction.terminal_path || ':' ||
        expected_transaction.transaction_kind || ':' ||
        expected_transaction.transaction_ordinal::TEXT || ':' ||
        expected_transaction.financial_event_id::TEXT || ':' ||
        expected_transaction.event_amount_cents::TEXT || ':' ||
        expected_transaction.currency || ':' ||
        expected_transaction.bridge_authority_chain_sha256 || ':' ||
        expected_transaction.intent_authority_context_sha256,
        'sha256'
      ),
      'hex'
    );

    INSERT INTO public.universal_v1_ledger_transactions_v1 (
      ledger_transaction_id, reconciliation_bridge_id, terminal_intent_id,
      reconciliation_fact_id, work_order_id, terminal_path, transaction_kind,
      transaction_ordinal, financial_event_id, event_amount_cents, currency,
      bridge_authority_chain_sha256, intent_authority_context_sha256,
      transaction_identity_sha256, recorded_at
    ) VALUES (
      expected_transaction.ledger_transaction_id,
      expected_transaction.reconciliation_bridge_id,
      expected_transaction.terminal_intent_id,
      expected_transaction.reconciliation_fact_id,
      expected_transaction.work_order_id,
      expected_transaction.terminal_path,
      expected_transaction.transaction_kind,
      expected_transaction.transaction_ordinal,
      expected_transaction.financial_event_id,
      expected_transaction.event_amount_cents,
      expected_transaction.currency,
      expected_transaction.bridge_authority_chain_sha256,
      expected_transaction.intent_authority_context_sha256,
      derived_transaction_identity,
      expected_transaction.event_occurred_at
    )
    ON CONFLICT (ledger_transaction_id) DO NOTHING;

    SELECT * INTO existing_transaction
      FROM public.universal_v1_ledger_transactions_v1
     WHERE ledger_transaction_id = expected_transaction.ledger_transaction_id;
    IF existing_transaction.transaction_identity_sha256 IS DISTINCT FROM
         derived_transaction_identity THEN
      RAISE EXCEPTION 'HXUV1-LEDGER-40: deterministic transaction identity conflicts on replay'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF found_authority IS FALSE THEN
    RETURN FALSE;
  END IF;

  FOR expected_posting IN
    SELECT *
      FROM public.universal_v1_expected_double_entry_postings_v1(
        checked_reconciliation_fact_id
      ) expected
     ORDER BY expected.transaction_ordinal, expected.posting_ordinal
  LOOP
    derived_posting_id := public.universal_v1_double_entry_uuid_v1(
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_POSTING_V1:' ||
      expected_posting.ledger_transaction_id::TEXT || ':' ||
      expected_posting.posting_ordinal::TEXT
    );
    derived_posting_identity := encode(
      digest(
        'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_POSTING_V1:' ||
        derived_posting_id::TEXT || ':' ||
        expected_posting.ledger_transaction_id::TEXT || ':' ||
        expected_posting.transaction_kind || ':' ||
        expected_posting.posting_ordinal::TEXT || ':' ||
        expected_posting.posting_side || ':' || expected_posting.account_code || ':' ||
        expected_posting.posting_amount_cents::TEXT || ':' || expected_posting.currency,
        'sha256'
      ),
      'hex'
    );

    INSERT INTO public.universal_v1_ledger_postings_v1 (
      ledger_posting_id, ledger_transaction_id, transaction_kind,
      posting_ordinal, posting_side, account_code, amount_cents, currency,
      posting_identity_sha256, recorded_at
    ) VALUES (
      derived_posting_id, expected_posting.ledger_transaction_id,
      expected_posting.transaction_kind, expected_posting.posting_ordinal,
      expected_posting.posting_side, expected_posting.account_code,
      expected_posting.posting_amount_cents, expected_posting.currency,
      derived_posting_identity, expected_posting.event_occurred_at
    )
    ON CONFLICT (ledger_transaction_id, posting_ordinal) DO NOTHING;

    SELECT * INTO existing_posting
      FROM public.universal_v1_ledger_postings_v1
     WHERE ledger_transaction_id = expected_posting.ledger_transaction_id
       AND posting_ordinal = expected_posting.posting_ordinal;
    IF existing_posting.ledger_posting_id IS DISTINCT FROM derived_posting_id
       OR existing_posting.posting_identity_sha256 IS DISTINCT FROM derived_posting_identity THEN
      RAISE EXCEPTION 'HXUV1-LEDGER-41: deterministic posting identity conflicts on replay'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  RETURN public.certify_universal_v1_double_entry_ledger_v1(
    checked_reconciliation_fact_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.require_universal_v1_double_entry_ledger_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  controlled_test_task BOOLEAN;
  matching_terminal_intent BOOLEAN := FALSE;
  certified BOOLEAN;
BEGIN
  IF NEW.ledger_state <> 'MATCHED'
     OR NEW.reconciliation_state NOT IN ('MATCHED', 'CLOSED')
     OR to_regclass('public.universal_v1_fake_reconciliation_bridges') IS NULL
     OR to_regclass('public.universal_v1_fake_terminal_lifecycle_intents') IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT task.automation_classification = 'CONTROLLED_TEST'
    INTO controlled_test_task
    FROM public.task_work_orders work_order
    JOIN public.tasks task ON task.id = work_order.task_id
   WHERE work_order.id = NEW.work_order_id;
  IF controlled_test_task IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  EXECUTE $intent_query$
    SELECT EXISTS (
      SELECT 1
        FROM public.universal_v1_fake_terminal_lifecycle_intents intent
       WHERE intent.work_order_id = $1
         AND $2 = intent.starting_reconciliation_version + 1
    )
  $intent_query$
  INTO matching_terminal_intent
  USING NEW.work_order_id, NEW.reconciliation_version;
  IF matching_terminal_intent IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  certified := public.materialize_universal_v1_double_entry_ledger_v1(NEW.id);
  IF certified IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1
         FROM public.universal_v1_ledger_certifications_v1 certification
        WHERE certification.reconciliation_fact_id = NEW.id
          AND certification.work_order_id = NEW.work_order_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-LEDGER-50: controlled-test terminal reconciliation cannot remain ledger_state=MATCHED without its exact certified double-entry ledger in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_double_entry_ledger_required_v1
  ON public.task_reconciliation_facts;
CREATE CONSTRAINT TRIGGER zz_universal_v1_double_entry_ledger_required_v1
AFTER INSERT ON public.task_reconciliation_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_universal_v1_double_entry_ledger_v1();

-- On an upgrade where post-engine fixtures already exist, backfill existing
-- exact bridges. The same deterministic identities and ON CONFLICT checks make
-- this backfill existing exact fake reconciliation bridges idempotently safe.
DO $$
DECLARE
  reconciliation_fact_id_to_backfill UUID;
BEGIN
  IF to_regclass('public.universal_v1_fake_reconciliation_bridges') IS NOT NULL
     AND to_regclass('public.universal_v1_fake_terminal_lifecycle_intents') IS NOT NULL THEN
    FOR reconciliation_fact_id_to_backfill IN
      EXECUTE $backfill_query$
        SELECT bridge.reconciliation_fact_id
          FROM public.universal_v1_fake_reconciliation_bridges bridge
          JOIN public.task_reconciliation_facts reconciliation
            ON reconciliation.id = bridge.reconciliation_fact_id
         WHERE reconciliation.ledger_state = 'MATCHED'
           AND reconciliation.reconciliation_state IN ('MATCHED', 'CLOSED')
         ORDER BY bridge.reconciliation_fact_id
      $backfill_query$
    LOOP
      IF public.materialize_universal_v1_double_entry_ledger_v1(
           reconciliation_fact_id_to_backfill
         ) IS NOT TRUE THEN
        RAISE EXCEPTION 'HXUV1-LEDGER-51: existing exact fake bridge could not be backfilled'
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-LEDGER-60: Universal V1 double-entry ledger evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_ledger_accounts_no_update_delete_v1
  ON public.universal_v1_ledger_accounts_v1;
CREATE TRIGGER universal_v1_ledger_accounts_no_update_delete_v1
BEFORE UPDATE OR DELETE ON public.universal_v1_ledger_accounts_v1
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_accounts_no_truncate_v1
  ON public.universal_v1_ledger_accounts_v1;
CREATE TRIGGER universal_v1_ledger_accounts_no_truncate_v1
BEFORE TRUNCATE ON public.universal_v1_ledger_accounts_v1
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_transactions_no_update_delete_v1
  ON public.universal_v1_ledger_transactions_v1;
CREATE TRIGGER universal_v1_ledger_transactions_no_update_delete_v1
BEFORE UPDATE OR DELETE ON public.universal_v1_ledger_transactions_v1
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_transactions_no_truncate_v1
  ON public.universal_v1_ledger_transactions_v1;
CREATE TRIGGER universal_v1_ledger_transactions_no_truncate_v1
BEFORE TRUNCATE ON public.universal_v1_ledger_transactions_v1
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_postings_no_update_delete_v1
  ON public.universal_v1_ledger_postings_v1;
CREATE TRIGGER universal_v1_ledger_postings_no_update_delete_v1
BEFORE UPDATE OR DELETE ON public.universal_v1_ledger_postings_v1
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_postings_no_truncate_v1
  ON public.universal_v1_ledger_postings_v1;
CREATE TRIGGER universal_v1_ledger_postings_no_truncate_v1
BEFORE TRUNCATE ON public.universal_v1_ledger_postings_v1
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_certifications_no_update_delete_v1
  ON public.universal_v1_ledger_certifications_v1;
CREATE TRIGGER universal_v1_ledger_certifications_no_update_delete_v1
BEFORE UPDATE OR DELETE ON public.universal_v1_ledger_certifications_v1
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_certifications_no_truncate_v1
  ON public.universal_v1_ledger_certifications_v1;
CREATE TRIGGER universal_v1_ledger_certifications_no_truncate_v1
BEFORE TRUNCATE ON public.universal_v1_ledger_certifications_v1
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_transaction_validate_v1
  ON public.universal_v1_ledger_transactions_v1;
CREATE TRIGGER universal_v1_ledger_transaction_validate_v1
BEFORE INSERT ON public.universal_v1_ledger_transactions_v1
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_ledger_transaction_v1();

DROP TRIGGER IF EXISTS universal_v1_ledger_posting_validate_v1
  ON public.universal_v1_ledger_postings_v1;
CREATE TRIGGER universal_v1_ledger_posting_validate_v1
BEFORE INSERT ON public.universal_v1_ledger_postings_v1
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_ledger_posting_v1();

COMMENT ON TABLE public.universal_v1_ledger_accounts_v1 IS
  'Closed provider-neutral Universal V1 chart. SUSPENSE_UNALLOCATED is not revenue or a fee policy.';
COMMENT ON TABLE public.universal_v1_ledger_transactions_v1 IS
  'Append-only exact lifecycle-event-bound double-entry transaction headers derived from fake terminal reconciliation authority.';
COMMENT ON TABLE public.universal_v1_ledger_postings_v1 IS
  'Append-only positive-cent debit/credit postings in the closed Universal V1 terminal-path matrix.';
COMMENT ON TABLE public.universal_v1_ledger_certifications_v1 IS
  'Commit-time proof that one exact fake terminal reconciliation has a complete immutable balanced ledger.';

REVOKE ALL ON TABLE public.universal_v1_ledger_accounts_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_ledger_transactions_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_ledger_postings_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_ledger_certifications_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_double_entry_posting_matrix_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_double_entry_uuid_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_expected_double_entry_postings_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_ledger_transaction_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_ledger_posting_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_ledger_certification_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.certify_universal_v1_double_entry_ledger_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.materialize_universal_v1_double_entry_ledger_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_universal_v1_double_entry_ledger_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_universal_v1_double_entry_ledger_mutation_v1() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.universal_v1_double_entry_posting_matrix_v1(TEXT)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.universal_v1_double_entry_uuid_v1(TEXT)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.universal_v1_expected_double_entry_postings_v1(UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.certify_universal_v1_double_entry_ledger_v1(UUID)
  TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.materialize_universal_v1_double_entry_ledger_v1(UUID)
  TO CURRENT_USER;
