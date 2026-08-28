-- Public pre-assignment task clarification, explicit material revision approval,
-- and acceptance gates. Public comments never mutate execution scope directly.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS clarification_state TEXT NOT NULL DEFAULT 'READY'
    CHECK (clarification_state IN ('READY', 'QUESTION_OPEN', 'REVISION_PENDING'));

CREATE TABLE IF NOT EXISTS task_public_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  asked_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  question_text TEXT NOT NULL CHECK (char_length(question_text) BETWEEN 1 AND 500),
  question_hash CHAR(64) NOT NULL CHECK (question_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  answer_text TEXT CHECK (answer_text IS NULL OR char_length(answer_text) BETWEEN 1 AND 500),
  answer_hash CHAR(64) CHECK (answer_hash IS NULL OR answer_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ANSWERED')),
  material_change BOOLEAN,
  answered_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, asked_by, idempotency_key),
  CHECK (
    (status = 'OPEN' AND answer_text IS NULL AND answer_hash IS NULL
      AND answered_by IS NULL AND answered_at IS NULL AND material_change IS NULL)
    OR
    (status = 'ANSWERED' AND answer_text IS NOT NULL AND answer_hash IS NOT NULL
      AND answered_by IS NOT NULL AND answered_at IS NOT NULL AND material_change IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS task_public_questions_task_time_idx
  ON task_public_questions(task_id, created_at ASC);

CREATE TABLE IF NOT EXISTS task_clarification_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  source_question_id UUID NOT NULL UNIQUE REFERENCES task_public_questions(id) ON DELETE RESTRICT,
  base_scope_version_id UUID NOT NULL REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  proposed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proposed_scope_summary TEXT NOT NULL CHECK (char_length(proposed_scope_summary) BETWEEN 1 AND 1000),
  proposed_checklist JSONB NOT NULL CHECK (
    jsonb_typeof(proposed_checklist) = 'array'
    AND jsonb_array_length(proposed_checklist) BETWEEN 1 AND 12
  ),
  proposed_customer_total_cents INTEGER NOT NULL CHECK (proposed_customer_total_cents > 0),
  proposed_hustler_payout_cents INTEGER NOT NULL CHECK (proposed_hustler_payout_cents > 0),
  proposed_platform_margin_cents INTEGER NOT NULL CHECK (proposed_platform_margin_cents >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING_POSTER_APPROVAL'
    CHECK (status IN ('PENDING_POSTER_APPROVAL', 'APPROVED', 'REJECTED')),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  review_reason TEXT CHECK (review_reason IS NULL OR char_length(review_reason) BETWEEN 10 AND 1000),
  approved_scope_version_id UUID REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (proposed_hustler_payout_cents + proposed_platform_margin_cents = proposed_customer_total_cents),
  CHECK (
    (status = 'PENDING_POSTER_APPROVAL' AND reviewed_by IS NULL
      AND review_reason IS NULL AND approved_scope_version_id IS NULL AND reviewed_at IS NULL)
    OR
    (status = 'APPROVED' AND reviewed_by IS NOT NULL
      AND review_reason IS NOT NULL AND approved_scope_version_id IS NOT NULL AND reviewed_at IS NOT NULL)
    OR
    (status = 'REJECTED' AND reviewed_by IS NOT NULL
      AND review_reason IS NOT NULL AND approved_scope_version_id IS NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS task_clarification_one_pending_revision_uniq
  ON task_clarification_revisions(task_id)
  WHERE status = 'PENDING_POSTER_APPROVAL';

CREATE INDEX IF NOT EXISTS task_clarification_revisions_task_time_idx
  ON task_clarification_revisions(task_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_public_question_lifecycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HXCL1: public clarification records cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id = NEW.task_id;
  IF TG_OP = 'INSERT' THEN
    IF NOT FOUND OR NEW.asked_by IS NOT DISTINCT FROM v_task.poster_id
       OR NEW.status <> 'OPEN'
       OR NOT EXISTS (
         SELECT 1 FROM worker_offer_decisions d
          WHERE d.task_id = NEW.task_id AND d.worker_id = NEW.asked_by
            AND d.decision_ready = TRUE AND d.expires_at > NOW()
            AND d.customer_total_cents = v_task.price
            AND d.payout_cents IS NOT DISTINCT FROM v_task.hustler_payout_cents
            AND d.scope_hash IS NOT DISTINCT FROM v_task.scope_hash
       ) THEN
      RAISE EXCEPTION 'HXCL4: only a currently eligible candidate can open a public question' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.asked_by IS DISTINCT FROM OLD.asked_by
     OR NEW.question_text IS DISTINCT FROM OLD.question_text
     OR NEW.question_hash IS DISTINCT FROM OLD.question_hash
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HXCL2: public clarification identity and content are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'OPEN' AND ROW(
       NEW.answer_text, NEW.answer_hash, NEW.status, NEW.material_change,
       NEW.answered_by, NEW.answered_at
     ) IS DISTINCT FROM ROW(
       OLD.answer_text, OLD.answer_hash, OLD.status, OLD.material_change,
       OLD.answered_by, OLD.answered_at
     ) THEN
    RAISE EXCEPTION 'HXCL3: public clarification answer is immutable after publication' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'OPEN' AND NEW.status = 'ANSWERED'
     AND NEW.answered_by IS DISTINCT FROM v_task.poster_id THEN
    RAISE EXCEPTION 'HXCL4: only the task Poster can publish a clarification answer' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_public_questions_lifecycle ON task_public_questions;
CREATE TRIGGER task_public_questions_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON task_public_questions
FOR EACH ROW EXECUTE FUNCTION enforce_public_question_lifecycle();

CREATE OR REPLACE FUNCTION enforce_clarification_revision_lifecycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_scope task_scope_versions%ROWTYPE;
  v_escrow escrows%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HXCL5: clarification revisions cannot be deleted' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_task FROM tasks WHERE id = NEW.task_id;
  IF NOT FOUND OR NEW.proposed_by IS DISTINCT FROM v_task.poster_id THEN
    RAISE EXCEPTION 'HXCL4: only the task Poster can propose or review a material revision' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM task_public_questions q
     WHERE q.id = NEW.source_question_id AND q.task_id = NEW.task_id
       AND q.status = 'ANSWERED' AND q.material_change = TRUE
  ) THEN
    RAISE EXCEPTION 'HXCL4: material revision requires its answered public question' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status <> 'PENDING_POSTER_APPROVAL' THEN
    RAISE EXCEPTION 'HXCL7: clarification revisions must begin pending Poster approval' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.task_id IS DISTINCT FROM OLD.task_id
       OR NEW.source_question_id IS DISTINCT FROM OLD.source_question_id
       OR NEW.base_scope_version_id IS DISTINCT FROM OLD.base_scope_version_id
       OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
       OR NEW.proposed_scope_summary IS DISTINCT FROM OLD.proposed_scope_summary
       OR NEW.proposed_checklist IS DISTINCT FROM OLD.proposed_checklist
       OR NEW.proposed_customer_total_cents IS DISTINCT FROM OLD.proposed_customer_total_cents
       OR NEW.proposed_hustler_payout_cents IS DISTINCT FROM OLD.proposed_hustler_payout_cents
       OR NEW.proposed_platform_margin_cents IS DISTINCT FROM OLD.proposed_platform_margin_cents
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'HXCL6: clarification revision proposal is immutable' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status <> 'PENDING_POSTER_APPROVAL' THEN
      RAISE EXCEPTION 'HXCL7: clarification revision decision is final' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.reviewed_by IS DISTINCT FROM v_task.poster_id THEN
      RAISE EXCEPTION 'HXCL4: reviewed_by IS DISTINCT FROM v_task.poster_id' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.status = 'APPROVED' THEN
      SELECT * INTO v_scope FROM task_scope_versions
       WHERE id = NEW.approved_scope_version_id AND task_id = NEW.task_id;
      IF NOT FOUND
         OR v_scope.source <> 'APPROVED_CHANGE'
         OR v_scope.created_by IS DISTINCT FROM v_task.poster_id
         OR v_scope.supersedes_version_id IS DISTINCT FROM NEW.base_scope_version_id
         OR v_scope.checklist IS DISTINCT FROM NEW.proposed_checklist
         OR NEW.proposed_customer_total_cents <> v_scope.customer_total_cents
         OR NEW.proposed_hustler_payout_cents IS DISTINCT FROM v_scope.hustler_payout_cents THEN
        RAISE EXCEPTION 'HXCL8: approved scope must exactly match the Poster-approved revision' USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO v_escrow FROM escrows WHERE task_id = NEW.task_id;
      IF NOT FOUND OR v_escrow.state <> 'PENDING' OR v_escrow.stripe_payment_intent_id IS NOT NULL THEN
        RAISE EXCEPTION 'HXCL8: repricing requires untouched pending payment state' USING ERRCODE = 'P0001';
      END IF;
    ELSIF NEW.status <> 'REJECTED' THEN
      RAISE EXCEPTION 'HXCL7: invalid clarification revision transition' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_clarification_revisions_lifecycle ON task_clarification_revisions;
CREATE TRIGGER task_clarification_revisions_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON task_clarification_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_clarification_revision_lifecycle();

CREATE OR REPLACE FUNCTION enforce_task_clarification_state()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_revision task_clarification_revisions%ROWTYPE;
BEGIN
  IF NEW.clarification_state = 'QUESTION_OPEN' AND NOT EXISTS (
    SELECT 1 FROM task_public_questions q WHERE q.task_id = NEW.id AND q.status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'HXCL8: QUESTION_OPEN requires an open public question' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.clarification_state = 'REVISION_PENDING' AND NOT EXISTS (
    SELECT 1 FROM task_clarification_revisions r
     WHERE r.task_id = NEW.id AND r.status = 'PENDING_POSTER_APPROVAL'
  ) THEN
    RAISE EXCEPTION 'HXCL8: clarification_state = ''REVISION_PENDING'' requires a pending revision' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.clarification_state = 'READY' AND (
    EXISTS (SELECT 1 FROM task_public_questions q WHERE q.task_id = NEW.id AND q.status = 'OPEN')
    OR EXISTS (
      SELECT 1 FROM task_clarification_revisions r
       WHERE r.task_id = NEW.id AND r.status = 'PENDING_POSTER_APPROVAL'
    )
  ) THEN
    RAISE EXCEPTION 'HXCL8: task cannot become READY with unresolved clarification' USING ERRCODE = 'P0001';
  END IF;

  IF OLD.clarification_state = 'REVISION_PENDING' AND (
    NEW.clarification_state IS DISTINCT FROM OLD.clarification_state
    OR NEW.price IS DISTINCT FROM OLD.price
    OR NEW.hustler_payout_cents IS DISTINCT FROM OLD.hustler_payout_cents
    OR NEW.platform_margin_cents IS DISTINCT FROM OLD.platform_margin_cents
    OR NEW.scope_hash IS DISTINCT FROM OLD.scope_hash
    OR NEW.active_scope_version_id IS DISTINCT FROM OLD.active_scope_version_id
  ) THEN
    SELECT * INTO v_revision FROM task_clarification_revisions r
     WHERE r.task_id = NEW.id AND r.status = 'APPROVED'
       AND r.approved_scope_version_id = NEW.active_scope_version_id
       AND r.proposed_customer_total_cents = NEW.price
       AND r.proposed_hustler_payout_cents IS NOT DISTINCT FROM NEW.hustler_payout_cents
       AND r.proposed_platform_margin_cents IS NOT DISTINCT FROM NEW.platform_margin_cents
     ORDER BY r.reviewed_at DESC LIMIT 1;
    IF NOT FOUND OR NEW.clarification_state <> 'READY' THEN
      RAISE EXCEPTION 'HXCL8: material task mutation requires the exact approved revision' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_clarification_state_gate ON tasks;
CREATE TRIGGER task_clarification_state_gate
BEFORE UPDATE OF clarification_state, price, hustler_payout_cents,
  platform_margin_cents, scope_hash, active_scope_version_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_clarification_state();

CREATE OR REPLACE FUNCTION enforce_task_clarification_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.clarification_state <> 'READY'
     OR EXISTS (SELECT 1 FROM task_public_questions q WHERE q.task_id = NEW.id AND q.status = 'OPEN')
     OR EXISTS (
       SELECT 1 FROM task_clarification_revisions r
        WHERE r.task_id = NEW.id AND r.status = 'PENDING_POSTER_APPROVAL'
     ) THEN
    RAISE EXCEPTION 'HXCL9: unresolved public clarification blocks acceptance' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_clarification_accept_gate ON tasks;
CREATE TRIGGER task_clarification_accept_gate
BEFORE UPDATE OF state, worker_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_clarification_on_accept();
