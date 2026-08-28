\set ON_ERROR_STOP on

-- Disposable pre-20260903 upgrade matrix. The source schema is deliberately
-- separate from public: poster_profiles and audit_log remain source evidence
-- and are never treated as canonical backend identity or claim events.
CREATE SCHEMA hx_task_draft_claim_source;

CREATE TABLE hx_task_draft_claim_source.poster_profiles (
  user_id UUID PRIMARY KEY,
  display_name TEXT,
  phone TEXT,
  email TEXT,
  default_zip TEXT,
  region TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE hx_task_draft_claim_source.audit_log (
  id BIGINT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  meta JSONB NOT NULL,
  at TIMESTAMPTZ NOT NULL
);

INSERT INTO users(id, email, full_name, default_mode)
VALUES
  ('f1000000-0000-4000-8000-000000000001', 'hx-claim-upgrade-owner@e2e.invalid',
   'HX Claim Upgrade Owner', 'poster'),
  ('f1000000-0000-4000-8000-000000000002', 'hx-claim-upgrade-other@e2e.invalid',
   'HX Claim Upgrade Other', 'poster'),
  ('f1000000-0000-4000-8000-000000000003', 'hx-claim-upgrade-preparer@e2e.invalid',
   'HX Claim Upgrade Preparer', 'poster'),
  ('f1000000-0000-4000-8000-000000000004', 'hx-claim-upgrade-reviewer@e2e.invalid',
   'HX Claim Upgrade Reviewer', 'poster');

INSERT INTO hx_task_draft_claim_source.poster_profiles(
  user_id, display_name, phone, email, default_zip, region, created_at, updated_at
) VALUES (
  'f6000000-0000-4000-8000-000000000001',
  'Legacy Poster Profile',
  '+12065550191',
  'hx-claim-upgrade-owner@e2e.invalid',
  '98052',
  'Eastside',
  TIMESTAMPTZ '2026-08-20T01:00:00Z',
  TIMESTAMPTZ '2026-08-20T01:01:00Z'
);

INSERT INTO leads(id, submission_id, lead_type, email, user_id)
VALUES (
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000002',
  'poster',
  'hx-claim-upgrade-owner@e2e.invalid',
  'f1000000-0000-4000-8000-000000000001'
);

-- Canonical and version-zero rows that must survive 20260903 byte-for-byte.
INSERT INTO task_drafts(
  id, submission_id, card_token_hash, raw_input, structured, status, source, utm,
  lead_id, poster_user_id, claimed_at, universal_contract_version,
  ingress_contract_version, ingress_origin, card_token_contract_version
) VALUES
  (
    'f3000000-0000-4000-8000-000000000001',
    'f3000000-0000-4000-8000-000000000002',
    encode(digest('hx-upgrade-canonical-unclaimed-token', 'sha256'), 'hex'),
    'Canonical unclaimed row must remain unchanged', '{}'::JSONB,
    'contact_captured', 'upgrade_contract_test', '{}'::JSONB,
    'f2000000-0000-4000-8000-000000000001', NULL, NULL,
    1, 1, 'BACKEND_POSTGRESQL', 1
  ),
  (
    'f3000000-0000-4000-8000-000000000003',
    'f3000000-0000-4000-8000-000000000004',
    encode(digest('hx-upgrade-unclassified-same-owner-token', 'sha256'), 'hex'),
    'Version-zero same-owner claim observation', '{}'::JSONB,
    'account_claimed', 'upgrade_contract_test', '{}'::JSONB,
    NULL, 'f1000000-0000-4000-8000-000000000001',
    TIMESTAMPTZ '2026-08-20T02:00:00Z',
    0, 0, 'UNCLASSIFIED_V0', 0
  ),
  (
    'f3000000-0000-4000-8000-000000000005',
    'f3000000-0000-4000-8000-000000000006',
    encode(digest('hx-upgrade-unclassified-other-owner-token', 'sha256'), 'hex'),
    'Version-zero other-owner claim observation', '{}'::JSONB,
    'account_claimed', 'upgrade_contract_test', '{}'::JSONB,
    NULL, 'f1000000-0000-4000-8000-000000000002',
    TIMESTAMPTZ '2026-08-20T03:00:00Z',
    0, 0, 'UNCLASSIFIED_V0', 0
  );

INSERT INTO task_draft_legacy_import_batches(
  id, source_system, source_environment, source_manifest_sha256,
  source_row_count, rate_continuity_mode, prepared_by, reviewed_by,
  prepared_at, reviewed_at
) VALUES (
  'f4000000-0000-4000-8000-000000000001',
  'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC',
  'synthetic-source-upgrade-fixture',
  repeat('a', 64),
  1,
  'FAIL_CLOSED',
  'f1000000-0000-4000-8000-000000000003',
  'f1000000-0000-4000-8000-000000000004',
  TIMESTAMPTZ '2026-08-20T04:00:00Z',
  TIMESTAMPTZ '2026-08-20T04:01:00Z'
);

INSERT INTO task_drafts(
  id, submission_id, card_token_hash, raw_input, structured, status, source, utm,
  universal_contract_version, ingress_contract_version, ingress_origin,
  card_token_contract_version, legacy_poster_auth_user_id,
  legacy_import_batch_id, legacy_source_row_sha256, legacy_import_disposition
) VALUES (
  'f3000000-0000-4000-8000-000000000007',
  'f3000000-0000-4000-8000-000000000008',
  encode(digest('f1a5c09b32764dba975c39b8120e4671f682dacb9e5354a89d62d880f411907c',
                'sha256'), 'hex'),
  'Exact receipt-backed legacy v0 row remains unclaimed and read-only',
  '{}'::JSONB,
  'contact_captured',
  'legacy_supabase_task_draft_public',
  '{}'::JSONB,
  0, 0, 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC', 0,
  'f6000000-0000-4000-8000-000000000001',
  'f4000000-0000-4000-8000-000000000001',
  repeat('b', 64),
  'IMPORTED_READ_ONLY'
);

INSERT INTO task_draft_legacy_import_receipts(
  id, import_batch_id, source_row_sha256, target_row_sha256,
  source_submission_id, source_card_token_hash, target_card_token_hash,
  legacy_poster_auth_user_id, target_task_draft_id, import_disposition,
  lead_disposition, token_disposition, route_disposition, reason_codes,
  recorded_by, recorded_at
) VALUES (
  'f5000000-0000-4000-8000-000000000001',
  'f4000000-0000-4000-8000-000000000001',
  repeat('b', 64),
  repeat('c', 64),
  'f3000000-0000-4000-8000-000000000008',
  encode(digest('f1a5c09b32764dba975c39b8120e4671f682dacb9e5354a89d62d880f411907c',
                'sha256'), 'hex'),
  encode(digest('f1a5c09b32764dba975c39b8120e4671f682dacb9e5354a89d62d880f411907c',
                'sha256'), 'hex'),
  'f6000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000007',
  'IMPORTED_READ_ONLY',
  'UNRESOLVED',
  'HASH_ONLY_READ_ONLY',
  'NO_SYNTHETIC_ROUTE',
  ARRAY['TASK_DRAFT_CLAIM_UPGRADE_FIXTURE'],
  'f1000000-0000-4000-8000-000000000004',
  TIMESTAMPTZ '2026-08-20T04:02:00Z'
);

INSERT INTO hx_task_draft_claim_source.audit_log(
  id, actor, action, target_type, target_id, meta, at
) VALUES (
  1,
  'poster',
  'task_draft_account_claimed',
  'task_draft',
  'f3000000-0000-4000-8000-000000000007',
  jsonb_build_object(
    'user_id', 'f6000000-0000-4000-8000-000000000001',
    'correlation_id', 'f6000000-0000-4000-8000-000000000002'
  ),
  TIMESTAMPTZ '2026-08-20T05:00:00Z'
);

SELECT 'HXUV1_TASK_DRAFT_CLAIM_UPGRADE_SEED_OK' AS result;
