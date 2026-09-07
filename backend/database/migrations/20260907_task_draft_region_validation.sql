ALTER TABLE task_drafts
ADD COLUMN IF NOT EXISTS region_code TEXT NULL;

ALTER TABLE task_drafts
ADD COLUMN IF NOT EXISTS region_policy_id UUID NULL;

ALTER TABLE task_drafts
ADD COLUMN IF NOT EXISTS region_policy_version TEXT NULL;

ALTER TABLE task_drafts
ADD COLUMN IF NOT EXISTS region_policy_hash CHAR(64) NULL;

ALTER TABLE task_drafts
ADD COLUMN IF NOT EXISTS region_policy_snapshot JSONB NULL;
