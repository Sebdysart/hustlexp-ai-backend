-- Immutable execution scope, checklist progress, and explicit scope-change approval.
--
-- New tasks bind the task row and scope version 1 in one transaction. The
-- deferrable active-version foreign key permits the task row to be inserted
-- before its immutable version row without weakening commit-time integrity.

CREATE TABLE IF NOT EXISTS task_scope_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  scope_hash VARCHAR(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requirements TEXT,
  checklist JSONB NOT NULL CHECK (jsonb_typeof(checklist) = 'array'),
  customer_total_cents INTEGER NOT NULL CHECK (customer_total_cents > 0),
  hustler_payout_cents INTEGER CHECK (hustler_payout_cents > 0),
  source TEXT NOT NULL CHECK (source IN ('INITIAL', 'APPROVED_CHANGE')),
  change_summary TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  supersedes_version_id UUID REFERENCES task_scope_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, version),
  UNIQUE (task_id, scope_hash)
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS active_scope_version_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_active_scope_version_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_active_scope_version_fk
      FOREIGN KEY (active_scope_version_id)
      REFERENCES task_scope_versions(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS task_scope_change_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  base_version_id UUID NOT NULL REFERENCES task_scope_versions(id),
  proposed_by UUID NOT NULL REFERENCES users(id),
  proposer_role TEXT NOT NULL CHECK (proposer_role IN ('POSTER', 'HUSTLER')),
  observed_scope_summary TEXT NOT NULL CHECK (char_length(observed_scope_summary) BETWEEN 1 AND 1000),
  proposed_checklist JSONB NOT NULL CHECK (jsonb_typeof(proposed_checklist) = 'array'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED')),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  decision_reason TEXT,
  approved_version_id UUID REFERENCES task_scope_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS task_scope_one_pending_change_uniq
  ON task_scope_change_proposals(task_id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS task_scope_changes_task_created_idx
  ON task_scope_change_proposals(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_scope_checklist_progress (
  version_id UUID NOT NULL REFERENCES task_scope_versions(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  completed_by UUID NOT NULL REFERENCES users(id),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (version_id, item_index)
);

ALTER TABLE proofs
  ADD COLUMN IF NOT EXISTS scope_version_id UUID REFERENCES task_scope_versions(id),
  ADD COLUMN IF NOT EXISTS scope_version_hash VARCHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proofs_scope_hash_format_ck'
  ) THEN
    ALTER TABLE proofs ADD CONSTRAINT proofs_scope_hash_format_ck CHECK (
      scope_version_hash IS NULL OR scope_version_hash ~ '^[a-f0-9]{64}$'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proofs_scope_binding_pair_ck'
  ) THEN
    ALTER TABLE proofs ADD CONSTRAINT proofs_scope_binding_pair_ck CHECK (
      (scope_version_id IS NULL AND scope_version_hash IS NULL)
      OR (scope_version_id IS NOT NULL AND scope_version_hash IS NOT NULL)
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS task_scope_versions_task_idx
  ON task_scope_versions(task_id, version DESC);

COMMENT ON COLUMN tasks.active_scope_version_id IS
  'Immutable execution scope currently approved by the Poster; new tasks set this at creation.';
COMMENT ON COLUMN proofs.scope_version_hash IS
  'Exact approved scope hash the submitted completion evidence claims to satisfy.';
