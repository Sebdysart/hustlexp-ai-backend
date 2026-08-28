\set ON_ERROR_STOP on

CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID REFERENCES users(id),
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  hustler_payout_cents INTEGER,
  platform_margin_cents INTEGER,
  region_code TEXT,
  trade_type TEXT,
  category TEXT
);
CREATE TABLE escrows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  amount INTEGER NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE task_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  rater_id UUID NOT NULL REFERENCES users(id),
  ratee_id UUID NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL,
  comment TEXT,
  tags TEXT[],
  UNIQUE(task_id, rater_id, ratee_id)
);

INSERT INTO users(id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003');

INSERT INTO tasks(
  id, poster_id, worker_id, state, title, description, price,
  hustler_payout_cents, platform_margin_cents, region_code, trade_type, category
) VALUES
  ('00000000-0000-4000-8000-000000000010',
   '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002',
   'COMPLETED', 'Move boxes', 'Move two boxes.', 7500, 6000, 1500,
   'US-WA', 'moving_labor', 'moving_labor'),
  ('00000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002',
   'ACCEPTED', 'Move boxes', 'Move two boxes.', 7500, 6000, 1500,
   'US-WA', 'moving_labor', 'moving_labor');

\ir ../../database/migrations/20260718_completion_retention_contract.sql

INSERT INTO tasks(
  id, poster_id, state, title, description, price, hustler_payout_cents,
  platform_margin_cents, region_code, trade_type, category,
  repeat_source_task_id, preferred_worker_id, retention_conversion
) VALUES (
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000001',
  'OPEN', 'Move boxes', 'Move two boxes.', 7500, 6000, 1500,
  'US-WA', 'moving_labor', 'moving_labor',
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000002', 'REBOOK'
);
INSERT INTO escrows(task_id, amount, state) VALUES
  ('00000000-0000-4000-8000-000000000020', 7500, 'PENDING');
INSERT INTO task_ratings(
  task_id, rater_id, ratee_id, stars, structured_feedback
) VALUES (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002', 5,
  '{"communication":5,"scopeAccuracy":4,"punctuality":3,"care":5,"resultQuality":4,"value":5}'::JSONB
);

DO $$
BEGIN
  BEGIN
    INSERT INTO tasks(
      poster_id, state, title, description, price, hustler_payout_cents,
      platform_margin_cents, region_code, trade_type, category,
      repeat_source_task_id, preferred_worker_id, retention_conversion
    ) VALUES (
      '00000000-0000-4000-8000-000000000001', 'OPEN', 'Bad source', 'Bad source.',
      7500, 6000, 1500, 'US-WA', 'moving_labor', 'moving_labor',
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000002', 'REBOOK'
    );
    RAISE EXCEPTION 'expected HXRT3';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM NOT LIKE 'HXRT3:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO tasks(
      poster_id, state, title, description, price, hustler_payout_cents,
      platform_margin_cents, region_code, trade_type, category,
      repeat_source_task_id, preferred_worker_id, retention_conversion
    ) VALUES (
      '00000000-0000-4000-8000-000000000003', 'OPEN', 'Forged poster', 'Forged poster.',
      7500, 6000, 1500, 'US-WA', 'moving_labor', 'moving_labor',
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000002', 'REBOOK'
    );
    RAISE EXCEPTION 'expected HXRT4';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM NOT LIKE 'HXRT4:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO tasks(
      poster_id, worker_id, state, title, description, price, hustler_payout_cents,
      platform_margin_cents, region_code, trade_type, category,
      repeat_source_task_id, preferred_worker_id, retention_conversion
    ) VALUES (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002', 'OPEN', 'Cloned assignment', 'Cloned assignment.',
      7500, 6000, 1500, 'US-WA', 'moving_labor', 'moving_labor',
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000002', 'REBOOK'
    );
    RAISE EXCEPTION 'expected HXRT5';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM NOT LIKE 'HXRT5:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO tasks(
      poster_id, state, title, description, price, hustler_payout_cents,
      platform_margin_cents, region_code, trade_type, category,
      repeat_source_task_id, preferred_worker_id, retention_conversion
    ) VALUES (
      '00000000-0000-4000-8000-000000000001', 'OPEN', 'Forged money', 'Forged money.',
      8500, 6000, 2500, 'US-WA', 'moving_labor', 'moving_labor',
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000002', 'REBOOK'
    );
    RAISE EXCEPTION 'expected HXRT6';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM NOT LIKE 'HXRT6:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE tasks SET preferred_worker_id = '00000000-0000-4000-8000-000000000003'
    WHERE id = '00000000-0000-4000-8000-000000000020';
    RAISE EXCEPTION 'expected HXRT8';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM NOT LIKE 'HXRT8:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO task_ratings(
      task_id, rater_id, ratee_id, stars, structured_feedback
    ) VALUES (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001', 5,
      '{"communication":5,"scopeAccuracy":4,"punctuality":3,"care":5,"resultQuality":4,"value":0}'::JSONB
    );
    RAISE EXCEPTION 'expected structured review check';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO task_ratings(
      task_id, rater_id, ratee_id, stars, structured_feedback
    ) VALUES (
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002', 5,
      '{"communication":5,"scopeAccuracy":5,"punctuality":5,"care":5,"resultQuality":5,"value":5}'::JSONB
    );
    RAISE EXCEPTION 'expected HXRV1';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM NOT LIKE 'HXRV1:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE task_ratings SET structured_feedback = jsonb_set(structured_feedback, '{care}', '1')
    WHERE task_id = '00000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'expected HXRV4';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM NOT LIKE 'HXRV4:%' THEN RAISE; END IF;
  END;
END
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM tasks
      WHERE id = '00000000-0000-4000-8000-000000000020'
        AND worker_id IS NULL AND state = 'OPEN'
        AND repeat_source_task_id = '00000000-0000-4000-8000-000000000010'
        AND preferred_worker_id = '00000000-0000-4000-8000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'valid rebook binding was not persisted';
  END IF;
  IF (SELECT count(*) FROM escrows
      WHERE task_id = '00000000-0000-4000-8000-000000000020'
        AND amount = 7500 AND state = 'PENDING') <> 1 THEN
    RAISE EXCEPTION 'fresh pending payment state was not persisted';
  END IF;
  IF (SELECT count(*) FROM task_ratings
      WHERE task_id = '00000000-0000-4000-8000-000000000010'
        AND structured_feedback->>'scopeAccuracy' = '4') <> 1 THEN
    RAISE EXCEPTION 'structured review was not persisted';
  END IF;
END
$$;

SELECT 'COMPLETION_RETENTION_DATABASE_CONTRACT_OK' AS result;
