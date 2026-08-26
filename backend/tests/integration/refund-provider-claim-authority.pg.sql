\set ON_ERROR_STOP on

BEGIN;
SET LOCAL hustlexp.is_test='true';
SET LOCAL hustlexp.local_test_identity_enabled='true';

CREATE OR REPLACE FUNCTION pg_temp.hxrefundclaim_assert(condition BOOLEAN,message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN
    RAISE EXCEPTION 'HXREFUNDCLAIM assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO tasks
SELECT (jsonb_populate_record(
  NULL::tasks,
  to_jsonb(source_task) || jsonb_build_object(
    'id','e2000000-0000-4000-8000-000000000001',
    'worker_id',NULL,
    'state','OPEN',
    'progress_state','POSTED',
    'title','Refund-provider claim acceptance guard',
    'version',7,
    'accepted_at',NULL,
    'completed_at',NULL
  )
)).*
FROM tasks source_task
WHERE source_task.id='b2000000-0000-4000-8000-000000000001';

INSERT INTO tasks
SELECT (jsonb_populate_record(
  NULL::tasks,
  to_jsonb(source_task) || jsonb_build_object(
    'id','e2000000-0000-4000-8000-000000000002',
    'worker_id','b1000000-0000-4000-8000-000000000002',
    'state','COMPLETED',
    'progress_state','COMPLETED',
    'title','Refund-provider claim release guard',
    'version',4,
    'accepted_at',clock_timestamp(),
    'completed_at',clock_timestamp()
  )
)).*
FROM tasks source_task
WHERE source_task.id='b2000000-0000-4000-8000-000000000001';

INSERT INTO escrows(
  id,task_id,amount,platform_fee_cents,state,stripe_payment_intent_id,
  funded_at,version
) VALUES
  (
    'e3000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    7500,1500,'FUNDED','pi_hxrefundclaim_1',clock_timestamp(),5
  ),
  (
    'e3000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000002',
    7500,1500,'FUNDED','pi_hxrefundclaim_2',clock_timestamp(),3
  );

WITH clock AS (
  SELECT transaction_timestamp() AS claimed_at
), claim_input AS (
  SELECT
    escrow.*,
    task.version AS task_version,
    task.state AS task_state,
    task.worker_id AS task_worker_id,
    'refund-provider-create-claim-v1:' || escrow.id::text || ':' ||
      escrow.version::text AS claim_key,
    'hx-refund-claim-v1:' || escrow.id::text || ':' ||
      escrow.version::text AS provider_key
  FROM escrows escrow
  JOIN tasks task ON task.id=escrow.task_id
  WHERE escrow.id IN (
    'e3000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000002'
  )
)
INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key,created_at
)
SELECT
  claim_input.id,'FUNDED','FUNDED',NULL,'system',
  jsonb_build_object(
    'event_type','refund_provider_create_claim_v1',
    'claim_idempotency_key',claim_input.claim_key,
    'provider','stripe',
    'escrow_id',claim_input.id::text,
    'task_id',claim_input.task_id::text,
    'canonical_state','FUNDED',
    'canonical_version',claim_input.version,
    'task_version',claim_input.task_version,
    'task_state',claim_input.task_state,
    'worker_id',claim_input.task_worker_id::text,
    'payment_intent_id',claim_input.stripe_payment_intent_id,
    'existing_refund_id',NULL,
    'refund_amount_cents',claim_input.amount,
    'currency','usd',
    'provider_idempotency_key',claim_input.provider_key,
    'provider_replay_deadline',to_jsonb(clock.claimed_at+INTERVAL '20 hours')
  ),
  claim_input.claim_key,
  clock.claimed_at
FROM claim_input
CROSS JOIN clock;

DO $$
BEGIN
  BEGIN
    UPDATE tasks
       SET state='ACCEPTED',worker_id='b1000000-0000-4000-8000-000000000002'
     WHERE id='e2000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'task acceptance with active refund claim unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN
    IF SQLERRM NOT LIKE 'HX002: task % has immutable refund-provider claim%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.hxrefundclaim_assert(
  (SELECT state='OPEN' AND worker_id IS NULL
     FROM tasks WHERE id='e2000000-0000-4000-8000-000000000001'),
  'active refund claim must block every task acceptance writer'
);

INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
)
SELECT
  escrow.id,'FUNDED','FUNDED',NULL,'system',
  'refund-provider-create-failed-v1:' || escrow.id::text || ':' ||
    escrow.version::text || ':STRIPE_TIMEOUT',
  jsonb_build_object(
    'event_type','refund_provider_create_failed_v1',
    'claim_idempotency_key','refund-provider-create-claim-v1:' ||
      escrow.id::text || ':' || escrow.version::text,
    'provider','stripe',
    'escrow_id',escrow.id::text,
    'task_id',escrow.task_id::text,
    'canonical_version',escrow.version,
    'payment_intent_id',escrow.stripe_payment_intent_id,
    'refund_amount_cents',escrow.amount,
    'provider_idempotency_key','hx-refund-claim-v1:' ||
      escrow.id::text || ':' || escrow.version::text,
    'provider_error_code','STRIPE_TIMEOUT',
    'claim_resolved',FALSE
  )
FROM escrows escrow
WHERE escrow.id='e3000000-0000-4000-8000-000000000002';

DO $$
BEGIN
  BEGIN
    UPDATE escrows
       SET state='RELEASED',
           stripe_transfer_id='tr_hxrefundclaim_forbidden',
           payout_provider='STRIPE',
           provider_transfer_id='tr_hxrefundclaim_forbidden',
           provider_transfer_status='submitted',
           released_at=clock_timestamp(),
           version=version+1,
           updated_at=clock_timestamp()
     WHERE id='e3000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'escrow release with unresolved refund claim unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN
    IF SQLERRM NOT LIKE 'HX002: escrow % has immutable refund-provider claim and cannot mutate outside exact refund%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.hxrefundclaim_assert(
  (SELECT state='FUNDED' AND stripe_transfer_id IS NULL AND version=3
     FROM escrows WHERE id='e3000000-0000-4000-8000-000000000002'),
  'ambiguous provider failure must not unblock release'
);

-- A crash-retained claim at version N must prevent a later version from
-- establishing a second provider-create authority for the same escrow. The
-- terminal trigger independently rejects this hostile duplicate even if a
-- caller manufactures an otherwise exact witness and resolution for version N.
INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
)
SELECT
  escrow.id,'FUNDED','FUNDED',NULL,'system',
  'refund-provider-create-claim-v1:' || escrow.id::text || ':4',
  jsonb_build_object(
    'event_type','refund_provider_create_claim_v1',
    'claim_idempotency_key','refund-provider-create-claim-v1:' || escrow.id::text || ':4',
    'provider','stripe',
    'escrow_id',escrow.id::text,
    'task_id',escrow.task_id::text,
    'canonical_state','FUNDED',
    'canonical_version',4,
    'task_version',task.version,
    'task_state',task.state,
    'worker_id',task.worker_id::text,
    'payment_intent_id',escrow.stripe_payment_intent_id,
    'existing_refund_id',NULL,
    'refund_amount_cents',escrow.amount,
    'currency','usd',
    'provider_idempotency_key','hx-refund-claim-v1:' || escrow.id::text || ':4',
    'provider_replay_deadline',to_jsonb(transaction_timestamp()+INTERVAL '20 hours')
  )
FROM escrows escrow
JOIN tasks task ON task.id=escrow.task_id
WHERE escrow.id='e3000000-0000-4000-8000-000000000002';

INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
) VALUES (
  'e3000000-0000-4000-8000-000000000002','FUNDED','FUNDED',NULL,'system',
  'exact-succeeded-refund-v1:e3000000-0000-4000-8000-000000000002:re_hxrefundclaim_duplicate',
  jsonb_build_object(
    'event_type','exact_succeeded_refund_witness_v1',
    'escrow_id','e3000000-0000-4000-8000-000000000002',
    'task_id','e2000000-0000-4000-8000-000000000002',
    'canonical_state','FUNDED',
    'payment_intent_id','pi_hxrefundclaim_2',
    'refund_id','re_hxrefundclaim_duplicate',
    'charge_id','ch_hxrefundclaim_duplicate',
    'amount_cents',7500,
    'currency','usd',
    'status','succeeded'
  )
);

DO $$
DECLARE
  v_escrow escrows%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_escrow FROM escrows
   WHERE id='e3000000-0000-4000-8000-000000000002';
  BEGIN
    INSERT INTO escrow_events(
      escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
    ) VALUES (
      v_escrow.id,'FUNDED','REFUNDED',NULL,'system',
      'refund-provider-claim-resolved-v1:' || v_escrow.id::text || ':' ||
        v_escrow.version::text || ':re_hxrefundclaim_duplicate',
      jsonb_build_object(
        'event_type','refund_provider_claim_resolved_v1',
        'claim_idempotency_key','refund-provider-create-claim-v1:' ||
          v_escrow.id::text || ':' || v_escrow.version::text,
        'provider','stripe',
        'escrow_id',v_escrow.id::text,
        'task_id',v_escrow.task_id::text,
        'canonical_state_before','FUNDED',
        'canonical_state_after','REFUNDED',
        'canonical_version_before',v_escrow.version,
        'canonical_version_after',v_escrow.version+1,
        'payment_intent_id',v_escrow.stripe_payment_intent_id,
        'refund_id','re_hxrefundclaim_duplicate',
        'refund_amount_cents',v_escrow.amount,
        'currency','usd',
        'provider_idempotency_key','hx-refund-claim-v1:' ||
          v_escrow.id::text || ':' || v_escrow.version::text,
        'provider_witness_idempotency_key','exact-succeeded-refund-v1:' ||
          v_escrow.id::text || ':re_hxrefundclaim_duplicate',
        'resolution','canonical_refunded'
      )
    );
    PERFORM set_config('hustlexp.refund_terminal_authority',v_escrow.id::text,true);
    UPDATE escrows
       SET state='REFUNDED',stripe_refund_id='re_hxrefundclaim_duplicate',
           refunded_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
     WHERE id=v_escrow.id;
    RAISE EXCEPTION 'multiple immutable refund claims unexpectedly terminalized';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;
SELECT pg_temp.hxrefundclaim_assert(
  (SELECT state='FUNDED' AND stripe_refund_id IS NULL AND version=3
     FROM escrows WHERE id='e3000000-0000-4000-8000-000000000002'),
  'multiple escrow-scoped provider claims must fail closed'
);

DO $$
BEGIN
  BEGIN
    SELECT set_config(
      'hustlexp.refund_terminal_authority',
      'e3000000-0000-4000-8000-000000000001',
      true
    );
    UPDATE escrows
       SET state='REFUNDED',stripe_refund_id='re_hxrefundclaim_exact',
           refunded_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
     WHERE id='e3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'refund without provider witness and resolution unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;

INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
) VALUES (
  'e3000000-0000-4000-8000-000000000001','FUNDED','FUNDED',NULL,'system',
  'exact-succeeded-refund-v1:e3000000-0000-4000-8000-000000000001:re_hxrefundclaim_exact',
  jsonb_build_object(
    'event_type','exact_succeeded_refund_witness_v1',
    'escrow_id','e3000000-0000-4000-8000-000000000001',
    'task_id','e2000000-0000-4000-8000-000000000001',
    'canonical_state','FUNDED',
    'payment_intent_id','pi_hxrefundclaim_1',
    'refund_id','re_hxrefundclaim_exact',
    'charge_id','ch_hxrefundclaim_exact',
    'amount_cents',7500,
    'currency','usd',
    'status','succeeded'
  )
);

DO $$
DECLARE
  v_escrow escrows%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_escrow FROM escrows
   WHERE id='e3000000-0000-4000-8000-000000000001';
  BEGIN
    INSERT INTO escrow_events(
      escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
    ) VALUES (
      v_escrow.id,'FUNDED','REFUNDED',NULL,'system',
      'refund-provider-claim-resolved-v1:' || v_escrow.id::text || ':' ||
        v_escrow.version::text || ':re_hxrefundclaim_exact',
      jsonb_build_object(
        'event_type','refund_provider_claim_resolved_v1',
        'claim_idempotency_key','refund-provider-create-claim-v1:' ||
          v_escrow.id::text || ':' || v_escrow.version::text,
        'provider','stripe',
        'escrow_id',v_escrow.id::text,
        'task_id',v_escrow.task_id::text,
        'canonical_state_before','FUNDED',
        'canonical_state_after','REFUNDED',
        'canonical_version_before',v_escrow.version,
        'canonical_version_after',v_escrow.version+1,
        'payment_intent_id',v_escrow.stripe_payment_intent_id,
        'refund_id','re_hxrefundclaim_exact',
        'refund_amount_cents',7499,
        'currency','usd',
        'provider_idempotency_key','hx-refund-claim-v1:' ||
          v_escrow.id::text || ':' || v_escrow.version::text,
        'provider_witness_idempotency_key','exact-succeeded-refund-v1:' ||
          v_escrow.id::text || ':re_hxrefundclaim_exact',
        'resolution','canonical_refunded'
      )
    );
    PERFORM set_config('hustlexp.refund_terminal_authority',v_escrow.id::text,true);
    UPDATE escrows
       SET state='REFUNDED',stripe_refund_id='re_hxrefundclaim_exact',
           refunded_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
     WHERE id=v_escrow.id;
    RAISE EXCEPTION 'forged refund resolution amount unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;
SELECT pg_temp.hxrefundclaim_assert(
  (SELECT state='FUNDED' AND stripe_refund_id IS NULL AND version=5
     FROM escrows WHERE id='e3000000-0000-4000-8000-000000000001'),
  'forged terminal resolution must leave canonical escrow funded'
);

INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
)
SELECT
  escrow.id,'FUNDED','REFUNDED',NULL,'system',
  'refund-provider-claim-resolved-v1:' || escrow.id::text || ':' ||
    escrow.version::text || ':re_hxrefundclaim_exact',
  jsonb_build_object(
    'event_type','refund_provider_claim_resolved_v1',
    'claim_idempotency_key','refund-provider-create-claim-v1:' ||
      escrow.id::text || ':' || escrow.version::text,
    'provider','stripe',
    'escrow_id',escrow.id::text,
    'task_id',escrow.task_id::text,
    'canonical_state_before','FUNDED',
    'canonical_state_after','REFUNDED',
    'canonical_version_before',escrow.version,
    'canonical_version_after',escrow.version+1,
    'payment_intent_id',escrow.stripe_payment_intent_id,
    'refund_id','re_hxrefundclaim_exact',
    'refund_amount_cents',escrow.amount,
    'currency','usd',
    'provider_idempotency_key','hx-refund-claim-v1:' ||
      escrow.id::text || ':' || escrow.version::text,
    'provider_witness_idempotency_key','exact-succeeded-refund-v1:' ||
      escrow.id::text || ':re_hxrefundclaim_exact',
    'resolution','canonical_refunded'
  )
FROM escrows escrow
WHERE escrow.id='e3000000-0000-4000-8000-000000000001';

SELECT set_config(
  'hustlexp.refund_terminal_authority',
  'e3000000-0000-4000-8000-000000000001',
  true
);
UPDATE escrows
   SET state='REFUNDED',stripe_refund_id='re_hxrefundclaim_exact',
       refunded_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
 WHERE id='e3000000-0000-4000-8000-000000000001';
SELECT pg_temp.hxrefundclaim_assert(
  (SELECT state='REFUNDED' AND version=6 AND amount=7500
          AND platform_fee_cents=1500
          AND stripe_payment_intent_id='pi_hxrefundclaim_1'
          AND stripe_refund_id='re_hxrefundclaim_exact'
     FROM escrows WHERE id='e3000000-0000-4000-8000-000000000001'),
  'exact claim, witness, and resolution must converge one immutable REFUNDED terminal'
);

DO $$
BEGIN
  BEGIN
    UPDATE tasks
       SET state='ACCEPTED',worker_id='b1000000-0000-4000-8000-000000000002'
     WHERE id='e2000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'task acceptance after terminal refund unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;

SELECT 'REFUND_PROVIDER_CLAIM_AUTHORITY_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
