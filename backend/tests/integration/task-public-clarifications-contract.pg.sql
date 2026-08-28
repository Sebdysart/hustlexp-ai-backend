\set ON_ERROR_STOP on

CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID REFERENCES users(id),
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requirements TEXT,
  price INTEGER NOT NULL,
  hustler_payout_cents INTEGER,
  platform_margin_cents INTEGER,
  scope_hash VARCHAR(64),
  active_scope_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE task_scope_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  scope_hash VARCHAR(64) NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requirements TEXT,
  checklist JSONB NOT NULL,
  customer_total_cents INTEGER NOT NULL,
  hustler_payout_cents INTEGER,
  source TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  supersedes_version_id UUID REFERENCES task_scope_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE escrows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  amount INTEGER NOT NULL,
  state TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO users(id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003');

INSERT INTO tasks(
  id, poster_id, state, title, description, price,
  hustler_payout_cents, platform_margin_cents, scope_hash
) VALUES (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000001', 'MATCHING',
  'Haul items', 'Remove boxed items.', 10000, 8000, 2000,
  repeat('a', 64)
);
INSERT INTO task_scope_versions(
  id, task_id, version, scope_hash, title, description, requirements,
  checklist, customer_total_cents, hustler_payout_cents, source,
  change_summary, created_by
) VALUES (
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000010', 1, repeat('a', 64),
  'Haul items', 'Remove boxed items.', NULL,
  '["Load removed items"]'::JSONB, 10000, 8000, 'INITIAL',
  'Initial approved execution scope', '00000000-0000-4000-8000-000000000001'
);
UPDATE tasks SET active_scope_version_id = '00000000-0000-4000-8000-000000000020'
 WHERE id = '00000000-0000-4000-8000-000000000010';
INSERT INTO escrows(task_id, amount, state) VALUES
  ('00000000-0000-4000-8000-000000000010', 10000, 'PENDING');

\ir ../../database/migrations/20260718_worker_offer_decision_contract.sql
\ir ../../database/migrations/20260718_task_public_clarifications.sql

INSERT INTO worker_offer_decisions(
  task_id, worker_id, policy_version, payload_hash, decision_ready,
  customer_total_cents, payout_cents, scope_hash, snapshot, expires_at
) VALUES (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000002', 'clarification-contract-v1',
  repeat('c', 64), TRUE, 10000, 8000, repeat('a', 64), '{}'::JSONB,
  NOW() + INTERVAL '1 hour'
);

INSERT INTO task_public_questions(
  id, task_id, asked_by, question_text, question_hash, idempotency_key
) VALUES (
  '00000000-0000-4000-8000-000000000030',
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000002',
  'Is disposal included?', repeat('d', 64), 'question-0001'
);
UPDATE tasks SET clarification_state = 'QUESTION_OPEN'
 WHERE id = '00000000-0000-4000-8000-000000000010';

DO $$
BEGIN
  BEGIN
    DELETE FROM task_public_questions
     WHERE id = '00000000-0000-4000-8000-000000000030';
    RAISE EXCEPTION 'expected HXCL1';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXCL1:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE task_public_questions SET question_text = 'Mutated question'
     WHERE id = '00000000-0000-4000-8000-000000000030';
    RAISE EXCEPTION 'expected HXCL2';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXCL2:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO task_public_questions(
      task_id, asked_by, question_text, question_hash, idempotency_key
    ) VALUES (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000003',
      'Can I see this task?', repeat('e', 64), 'question-0002'
    );
    RAISE EXCEPTION 'expected HXCL4';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXCL4:%' THEN RAISE; END IF;
  END;
END
$$;

UPDATE task_public_questions
   SET answer_text = 'Disposal requires a revised scope and total.',
       answer_hash = repeat('e', 64), status = 'ANSWERED', material_change = TRUE,
       answered_by = '00000000-0000-4000-8000-000000000001', answered_at = NOW()
 WHERE id = '00000000-0000-4000-8000-000000000030';

DO $$
BEGIN
  BEGIN
    INSERT INTO task_clarification_revisions(
      task_id, source_question_id, base_scope_version_id, proposed_by,
      proposed_scope_summary, proposed_checklist,
      proposed_customer_total_cents, proposed_hustler_payout_cents,
      proposed_platform_margin_cents
    ) VALUES (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000020',
      '00000000-0000-4000-8000-000000000002',
      'Forged candidate revision', '["Load removed items","Dispose items"]'::JSONB,
      12000, 9000, 3000
    );
    RAISE EXCEPTION 'expected HXCL4';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXCL4:%' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO task_clarification_revisions(
  id, task_id, source_question_id, base_scope_version_id, proposed_by,
  proposed_scope_summary, proposed_checklist,
  proposed_customer_total_cents, proposed_hustler_payout_cents,
  proposed_platform_margin_cents
) VALUES (
  '00000000-0000-4000-8000-000000000040',
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000030',
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000001',
  'Add disposal to haul-away.', '["Load removed items","Dispose items"]'::JSONB,
  12000, 9000, 3000
);
UPDATE tasks SET clarification_state = 'REVISION_PENDING'
 WHERE id = '00000000-0000-4000-8000-000000000010';

DO $$
BEGIN
  BEGIN
    UPDATE tasks SET clarification_state = 'READY'
     WHERE id = '00000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'expected HXCL8';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXCL8:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE task_clarification_revisions SET proposed_customer_total_cents = 13000
     WHERE id = '00000000-0000-4000-8000-000000000040';
    RAISE EXCEPTION 'expected HXCL6';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXCL6:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE tasks SET state = 'ACCEPTED', worker_id = '00000000-0000-4000-8000-000000000002'
     WHERE id = '00000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'expected HXCL9';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXCL9:%' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO task_scope_versions(
  id, task_id, version, scope_hash, title, description, requirements,
  checklist, customer_total_cents, hustler_payout_cents, source,
  change_summary, created_by, supersedes_version_id
) VALUES (
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000010', 2, repeat('b', 64),
  'Haul items', 'Remove boxed items.', NULL,
  '["Load removed items","Dispose items"]'::JSONB, 12000, 9000,
  'APPROVED_CHANGE', 'Add disposal to haul-away.',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000020'
);
UPDATE task_clarification_revisions
   SET status = 'APPROVED', reviewed_by = '00000000-0000-4000-8000-000000000001',
       review_reason = 'The revised scope and total are correct.',
       approved_scope_version_id = '00000000-0000-4000-8000-000000000021',
       reviewed_at = NOW()
 WHERE id = '00000000-0000-4000-8000-000000000040';
UPDATE tasks
   SET price = 12000, hustler_payout_cents = 9000, platform_margin_cents = 3000,
       scope_hash = repeat('b', 64),
       active_scope_version_id = '00000000-0000-4000-8000-000000000021',
       clarification_state = 'READY'
 WHERE id = '00000000-0000-4000-8000-000000000010';
UPDATE escrows SET amount = 12000, version = version + 1
 WHERE task_id = '00000000-0000-4000-8000-000000000010' AND state = 'PENDING';

DO $$
BEGIN
  BEGIN
    UPDATE tasks SET state = 'ACCEPTED', worker_id = '00000000-0000-4000-8000-000000000002'
     WHERE id = '00000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'expected HXWO3';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXWO3:%' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO worker_offer_decisions(
  task_id, worker_id, policy_version, payload_hash, decision_ready,
  customer_total_cents, payout_cents, scope_hash, snapshot, expires_at
) VALUES (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000002', 'clarification-contract-v2',
  repeat('f', 64), TRUE, 12000, 9000, repeat('b', 64), '{}'::JSONB,
  NOW() + INTERVAL '1 hour'
);
UPDATE tasks SET state = 'ACCEPTED', worker_id = '00000000-0000-4000-8000-000000000002'
 WHERE id = '00000000-0000-4000-8000-000000000010';

DO $$
BEGIN
  IF (SELECT count(*) FROM tasks
      WHERE id = '00000000-0000-4000-8000-000000000010'
        AND clarification_state = 'READY' AND state = 'ACCEPTED'
        AND price = 12000 AND hustler_payout_cents = 9000
        AND platform_margin_cents = 3000
        AND active_scope_version_id = '00000000-0000-4000-8000-000000000021') <> 1 THEN
    RAISE EXCEPTION 'approved clarification state was not persisted exactly';
  END IF;
END
$$;

SELECT 'TASK_PUBLIC_CLARIFICATION_DATABASE_CONTRACT_OK' AS result;
