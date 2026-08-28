-- HX/OS completion retention contract.
-- Rebooks are separate canonical tasks with a fresh PENDING escrow. The prior
-- worker is a preference only and never becomes an assignment through cloning.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS repeat_source_task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS preferred_worker_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retention_conversion VARCHAR(20),
  ADD COLUMN IF NOT EXISTS retention_binding_created_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_retention_conversion_check
    CHECK (retention_conversion IS NULL OR retention_conversion = 'REBOOK');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_repeat_source ON tasks(repeat_source_task_id)
  WHERE repeat_source_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_preferred_worker ON tasks(preferred_worker_id, state)
  WHERE preferred_worker_id IS NOT NULL AND state IN ('OPEN', 'MATCHING');

CREATE OR REPLACE FUNCTION enforce_task_retention_binding()
RETURNS TRIGGER AS $$
DECLARE
  source_row RECORD;
BEGIN
  IF NEW.retention_conversion IS NULL
     AND NEW.repeat_source_task_id IS NULL
     AND NEW.preferred_worker_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.retention_conversion <> 'REBOOK'
     OR NEW.repeat_source_task_id IS NULL
     OR NEW.preferred_worker_id IS NULL THEN
    RAISE EXCEPTION 'HXRT1: rebook retention binding must be complete' USING ERRCODE = '23514';
  END IF;
  IF NEW.id = NEW.repeat_source_task_id THEN
    RAISE EXCEPTION 'HXRT2: a task cannot rebook itself' USING ERRCODE = '23514';
  END IF;

  SELECT id, poster_id, worker_id, state, price, hustler_payout_cents,
         platform_margin_cents, region_code, trade_type
    INTO source_row FROM tasks WHERE id = NEW.repeat_source_task_id FOR SHARE;
  IF NOT FOUND OR source_row.state <> 'COMPLETED' OR source_row.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXRT3: rebook source must be a completed assigned task' USING ERRCODE = '23514';
  END IF;
  IF source_row.poster_id <> NEW.poster_id OR source_row.worker_id <> NEW.preferred_worker_id THEN
    RAISE EXCEPTION 'HXRT4: rebook participants must match the source transaction' USING ERRCODE = '23514';
  END IF;
  IF NEW.state NOT IN ('OPEN', 'MATCHING') OR NEW.worker_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXRT5: rebook cannot clone an assignment' USING ERRCODE = '23514';
  END IF;
  IF NEW.price <> source_row.price
     OR NEW.hustler_payout_cents IS DISTINCT FROM source_row.hustler_payout_cents
     OR NEW.platform_margin_cents IS DISTINCT FROM source_row.platform_margin_cents THEN
    RAISE EXCEPTION 'HXRT6: rebook economics must match the customer-confirmed source' USING ERRCODE = '23514';
  END IF;
  IF NEW.region_code IS DISTINCT FROM source_row.region_code
     OR NEW.trade_type IS DISTINCT FROM source_row.trade_type THEN
    RAISE EXCEPTION 'HXRT7: rebook region and category must match the source' USING ERRCODE = '23514';
  END IF;
  NEW.retention_binding_created_at := COALESCE(NEW.retention_binding_created_at, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_retention_binding_gate ON tasks;
CREATE TRIGGER task_retention_binding_gate
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_task_retention_binding();

CREATE OR REPLACE FUNCTION prevent_task_retention_binding_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.repeat_source_task_id IS DISTINCT FROM NEW.repeat_source_task_id
     OR OLD.preferred_worker_id IS DISTINCT FROM NEW.preferred_worker_id
     OR OLD.retention_conversion IS DISTINCT FROM NEW.retention_conversion
     OR OLD.retention_binding_created_at IS DISTINCT FROM NEW.retention_binding_created_at THEN
    RAISE EXCEPTION 'HXRT8: rebook retention binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_retention_binding_immutable ON tasks;
CREATE TRIGGER task_retention_binding_immutable
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION prevent_task_retention_binding_mutation();

ALTER TABLE task_ratings
  ADD COLUMN IF NOT EXISTS structured_feedback JSONB;

DO $$ BEGIN
  ALTER TABLE task_ratings ADD CONSTRAINT task_ratings_structured_feedback_check CHECK (
    structured_feedback IS NULL OR (
      jsonb_typeof(structured_feedback) = 'object'
      AND structured_feedback ?& ARRAY['communication','scopeAccuracy','punctuality','care','resultQuality','value']
      AND (structured_feedback->>'communication')::INT BETWEEN 1 AND 5
      AND (structured_feedback->>'scopeAccuracy')::INT BETWEEN 1 AND 5
      AND (structured_feedback->>'punctuality')::INT BETWEEN 1 AND 5
      AND (structured_feedback->>'care')::INT BETWEEN 1 AND 5
      AND (structured_feedback->>'resultQuality')::INT BETWEEN 1 AND 5
      AND (structured_feedback->>'value')::INT BETWEEN 1 AND 5
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_task_ratings_structured_feedback
  ON task_ratings USING GIN (structured_feedback)
  WHERE structured_feedback IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_transaction_linked_task_review()
RETURNS TRIGGER AS $$
DECLARE
  task_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.rater_id IS DISTINCT FROM NEW.rater_id
    OR OLD.ratee_id IS DISTINCT FROM NEW.ratee_id
    OR OLD.stars IS DISTINCT FROM NEW.stars
    OR OLD.comment IS DISTINCT FROM NEW.comment
    OR OLD.tags IS DISTINCT FROM NEW.tags
    OR OLD.structured_feedback IS DISTINCT FROM NEW.structured_feedback
  ) THEN
    RAISE EXCEPTION 'HXRV4: completed-task review content is immutable' USING ERRCODE = '23514';
  END IF;

  SELECT state, poster_id, worker_id INTO task_row FROM tasks WHERE id = NEW.task_id FOR SHARE;
  IF NOT FOUND OR task_row.state <> 'COMPLETED' OR task_row.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXRV1: review requires a completed assigned transaction' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (NEW.rater_id = task_row.poster_id AND NEW.ratee_id = task_row.worker_id)
    OR (NEW.rater_id = task_row.worker_id AND NEW.ratee_id = task_row.poster_id)
  ) THEN
    RAISE EXCEPTION 'HXRV2: reviewer and reviewed user must be transaction participants' USING ERRCODE = '23514';
  END IF;
  IF NEW.structured_feedback IS NOT NULL AND NEW.rater_id <> task_row.poster_id THEN
    RAISE EXCEPTION 'HXRV3: structured outcome review must come from the Poster' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_review_transaction_gate ON task_ratings;
CREATE TRIGGER task_review_transaction_gate
  BEFORE INSERT OR UPDATE OF task_id, rater_id, ratee_id, stars, comment, tags, structured_feedback
  ON task_ratings
  FOR EACH ROW EXECUTE FUNCTION enforce_transaction_linked_task_review();
