-- Administrative original-proof approval is distinct from customer consent.
ALTER TABLE proofs ADD COLUMN review_source TEXT
  CHECK (review_source IS NULL OR review_source IN ('CUSTOMER', 'OPS_OVERRIDE'));
ALTER TABLE proofs ADD CONSTRAINT proofs_id_task_uq UNIQUE (id, task_id);

CREATE TABLE task_completion_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  proof_id UUID NOT NULL,
  ops_actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  internal_reason TEXT NOT NULL CHECK (char_length(btrim(internal_reason)) BETWEEN 10 AND 2000),
  completion_source TEXT NOT NULL DEFAULT 'OPS_OVERRIDE' CHECK (completion_source = 'OPS_OVERRIDE'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (proof_id, task_id) REFERENCES proofs(id, task_id) ON DELETE RESTRICT
);

ALTER TABLE tasks ADD COLUMN completion_source TEXT
  CHECK (completion_source IS NULL OR completion_source IN ('POSTER_CONFIRMED', 'UNATTENDED', 'OPS_OVERRIDE'));

-- Receipt-bound access to original proof media for authorized Ops review.
CREATE TABLE ops_proof_media_access_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proof_id UUID NOT NULL REFERENCES proofs(id) ON DELETE RESTRICT,
  receipt_id UUID NOT NULL REFERENCES media_upload_receipts(id) ON DELETE RESTRICT,
  ops_actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  signed_url_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
