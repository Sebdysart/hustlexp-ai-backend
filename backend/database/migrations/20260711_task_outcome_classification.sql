-- Explicit outcome provenance. Legacy rows remain UNCLASSIFIED and are excluded
-- from automation business metrics until independently reconciled.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS automation_classification TEXT;

UPDATE tasks
SET automation_classification = 'UNCLASSIFIED'
WHERE automation_classification IS NULL;

ALTER TABLE tasks ALTER COLUMN automation_classification SET DEFAULT 'PRODUCTION';
ALTER TABLE tasks ALTER COLUMN automation_classification SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_automation_classification_check'
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_automation_classification_check
      CHECK (automation_classification IN ('PRODUCTION', 'CONTROLLED_TEST', 'UNCLASSIFIED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_production_outcomes
  ON tasks (created_at DESC, id)
  WHERE automation_classification = 'PRODUCTION';
