-- Append-only convergence for the task state machine used by the API and
-- workers. The original constitutional schema omitted MATCHING even though
-- instant dispatch creates and accepts tasks through that state.
--
-- This migration changes schema only. It neither enables instant dispatch nor
-- authorizes assignment, payment, deployment, or any production capability.

DO $$
BEGIN
  IF to_regclass('public.tasks') IS NULL THEN
    RAISE EXCEPTION 'HXTASKSTATE1: tasks table is required'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS instant_mode BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_state_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_state_check CHECK (state IN (
    'OPEN',
    'MATCHING',
    'ACCEPTED',
    'PROOF_SUBMITTED',
    'DISPUTED',
    'COMPLETED',
    'CANCELLED',
    'EXPIRED'
  )) NOT VALID;

ALTER TABLE tasks
  VALIDATE CONSTRAINT tasks_state_check;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_instant_mode_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_instant_mode_check CHECK (
    instant_mode IS FALSE OR state <> 'OPEN'
  ) NOT VALID;

ALTER TABLE tasks
  VALIDATE CONSTRAINT tasks_instant_mode_check;

CREATE INDEX IF NOT EXISTS idx_tasks_instant_matching_queue_v1
  ON tasks(created_at, id)
  WHERE instant_mode IS TRUE AND state = 'MATCHING' AND worker_id IS NULL;

COMMENT ON CONSTRAINT tasks_state_check ON tasks IS
  'Canonical task states shared by TaskService, TaskAcceptService, and workers.';

COMMENT ON CONSTRAINT tasks_instant_mode_check ON tasks IS
  'Instant tasks enter MATCHING rather than the standard OPEN intake state.';
