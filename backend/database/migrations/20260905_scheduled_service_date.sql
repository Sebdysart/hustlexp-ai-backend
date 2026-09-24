ALTER TABLE task_drafts
ADD COLUMN IF NOT EXISTS scheduled_service_date date NULL;

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS scheduled_service_date date NULL;