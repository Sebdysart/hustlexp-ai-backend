ALTER TABLE task_drafts
ADD COLUMN IF NOT EXISTS validated_risk_level TEXT NULL;

ALTER TABLE task_drafts
ADD COLUMN IF NOT EXISTS compliance_result JSONB NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'task_drafts_validated_risk_level_check'
  ) THEN
    ALTER TABLE task_drafts
    ADD CONSTRAINT task_drafts_validated_risk_level_check
    CHECK (
      validated_risk_level IS NULL
      OR validated_risk_level IN (
        'LOW',
        'MEDIUM',
        'HIGH',
        'IN_HOME'
      )
    );
  END IF;
END
$$;
