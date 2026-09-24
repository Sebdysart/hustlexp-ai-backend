BEGIN;

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE leads ALTER COLUMN email DROP NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_verified_identity_chk,
  ADD CONSTRAINT users_verified_identity_chk
    CHECK (email IS NOT NULL OR phone IS NOT NULL);

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_contact_or_owner_chk,
  ADD CONSTRAINT leads_contact_or_owner_chk
    CHECK (email IS NOT NULL OR phone IS NOT NULL OR user_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
  ON users(phone)
  WHERE phone IS NOT NULL;

ALTER TABLE sms_outbox ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE sms_outbox
  ADD COLUMN IF NOT EXISTS recipient_kind TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS recipient_context_id UUID;

CREATE TABLE IF NOT EXISTS pending_phone_draft_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL UNIQUE REFERENCES task_drafts(id) ON DELETE CASCADE,
  intended_phone_e164 TEXT NOT NULL,
  intended_phone_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'CLAIMED', 'EXPIRED', 'REVOKED')),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at TIMESTAMPTZ,
  created_by_ops_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  audit_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_phone_draft_claims_open
  ON pending_phone_draft_claims(expires_at)
  WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_pending_phone_draft_claims_phone
  ON pending_phone_draft_claims(intended_phone_hash, status);

ALTER TABLE sms_outbox
  DROP CONSTRAINT IF EXISTS sms_outbox_recipient_kind_chk,
  ADD CONSTRAINT sms_outbox_recipient_kind_chk
    CHECK (recipient_kind IN ('user', 'pending_phone_claim')),
  DROP CONSTRAINT IF EXISTS sms_outbox_recipient_shape_chk,
  ADD CONSTRAINT sms_outbox_recipient_shape_chk CHECK (
    (recipient_kind = 'user' AND user_id IS NOT NULL)
    OR
    (recipient_kind = 'pending_phone_claim' AND user_id IS NULL AND recipient_context_id IS NOT NULL)
  );

ALTER TABLE sms_outbox
  DROP CONSTRAINT IF EXISTS sms_outbox_pending_claim_fk,
  ADD CONSTRAINT sms_outbox_pending_claim_fk
    FOREIGN KEY (recipient_context_id) REFERENCES pending_phone_draft_claims(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS sms_outbox_pending_claim_idempotency
  ON sms_outbox(recipient_context_id, idempotency_key)
  WHERE recipient_kind = 'pending_phone_claim';

COMMIT;
