-- Canonical backend/PostgreSQL compatibility rail for the contained
-- Supabase task-draft-public writer.
--
-- This migration is additive. It records where a TaskDraft entered the
-- system, which token/IP hashing contract applies, and hash-only evidence for
-- any later reviewed legacy import. It does not import source rows, infer
-- canonical foreign keys, create routing decisions, or grant money or
-- deployment capability.

-- A completed import batch is one immutable two-person-reviewed fact. Source
-- system identifiers and secret-manager references are evidence, never secret
-- values or customer content.
CREATE TABLE IF NOT EXISTS public.task_draft_legacy_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system TEXT NOT NULL CHECK (
    source_system = 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC'
  ),
  source_environment TEXT NOT NULL CHECK (
    char_length(btrim(source_environment)) BETWEEN 2 AND 64
  ),
  source_manifest_sha256 CHAR(64) NOT NULL CHECK (
    source_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_row_count BIGINT NOT NULL CHECK (source_row_count >= 0),
  import_contract_version SMALLINT NOT NULL DEFAULT 1 CHECK (
    import_contract_version = 1
  ),
  import_mode TEXT NOT NULL DEFAULT 'READ_ONLY_NO_ROUTE' CHECK (
    import_mode = 'READ_ONLY_NO_ROUTE'
  ),
  rate_continuity_mode TEXT NOT NULL CHECK (
    rate_continuity_mode IN (
      'DUAL_SCHEME_SECRET_REFERENCE',
      'WAIT_ONE_HOUR_AFTER_WRITER_DISABLE',
      'FAIL_CLOSED'
    )
  ),
  legacy_ip_hash_salt_reference TEXT CHECK (
    legacy_ip_hash_salt_reference IS NULL
    OR char_length(btrim(legacy_ip_hash_salt_reference)) BETWEEN 8 AND 240
  ),
  legacy_writer_disabled_at TIMESTAMPTZ,
  backend_accept_not_before TIMESTAMPTZ,
  prepared_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  prepared_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_system, source_environment, source_manifest_sha256),
  CHECK (prepared_by <> reviewed_by),
  CHECK (reviewed_at >= prepared_at),
  CHECK (
    (
      rate_continuity_mode = 'DUAL_SCHEME_SECRET_REFERENCE'
      AND legacy_ip_hash_salt_reference IS NOT NULL
      AND backend_accept_not_before IS NULL
    )
    OR (
      rate_continuity_mode = 'WAIT_ONE_HOUR_AFTER_WRITER_DISABLE'
      AND legacy_ip_hash_salt_reference IS NULL
      AND legacy_writer_disabled_at IS NOT NULL
      AND backend_accept_not_before IS NOT NULL
      AND backend_accept_not_before >= legacy_writer_disabled_at + interval '1 hour'
    )
    OR (
      rate_continuity_mode = 'FAIL_CLOSED'
      AND legacy_ip_hash_salt_reference IS NULL
      AND backend_accept_not_before IS NULL
    )
  )
);

ALTER TABLE public.task_drafts
  ADD COLUMN IF NOT EXISTS ingress_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ingress_origin TEXT NOT NULL DEFAULT 'UNCLASSIFIED_V0',
  ADD COLUMN IF NOT EXISTS card_token_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ip_hash_scheme TEXT,
  ADD COLUMN IF NOT EXISTS legacy_lead_submission_id UUID,
  ADD COLUMN IF NOT EXISTS legacy_poster_auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS legacy_quote_id UUID,
  ADD COLUMN IF NOT EXISTS legacy_engine_task_id TEXT,
  ADD COLUMN IF NOT EXISTS legacy_import_batch_id UUID
    REFERENCES public.task_draft_legacy_import_batches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS legacy_source_row_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS legacy_import_disposition TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_ingress_contract_version_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_ingress_contract_version_check CHECK (
        ingress_contract_version IN (0, 1)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_ingress_origin_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_ingress_origin_check CHECK (
        ingress_origin IN (
          'UNCLASSIFIED_V0',
          'BACKEND_POSTGRESQL',
          'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_card_token_contract_version_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_card_token_contract_version_check CHECK (
        card_token_contract_version IN (0, 1)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_ip_hash_scheme_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_ip_hash_scheme_check CHECK (
        ip_hash_scheme IS NULL
        OR ip_hash_scheme IN (
          'UNKNOWN_V0',
          'LEGACY_SHA256_IP_SUFFIX_V1',
          'HMAC_SHA256_V1'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_ip_hash_presence_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_ip_hash_presence_check CHECK (
        (ip_hash IS NULL AND ip_hash_scheme IS NULL)
        OR (ip_hash IS NOT NULL AND ip_hash_scheme IS NOT NULL)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_legacy_source_row_sha256_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_legacy_source_row_sha256_check CHECK (
        legacy_source_row_sha256 IS NULL
        OR legacy_source_row_sha256 ~ '^[0-9a-f]{64}$'
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_legacy_import_disposition_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_legacy_import_disposition_check CHECK (
        legacy_import_disposition IS NULL
        OR legacy_import_disposition IN (
          'IMPORTED_READ_ONLY',
          'RESUMABLE_AFTER_EXPLICIT_PROOF',
          'UNRESOLVED',
          'UNVERIFIED',
          'QUARANTINED'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_ingress_origin_evidence_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_ingress_origin_evidence_check CHECK (
        (
          ingress_origin = 'UNCLASSIFIED_V0'
          AND ingress_contract_version = 0
          AND card_token_contract_version = 0
          AND legacy_import_batch_id IS NULL
          AND legacy_source_row_sha256 IS NULL
          AND legacy_import_disposition IS NULL
          AND legacy_lead_submission_id IS NULL
          AND legacy_poster_auth_user_id IS NULL
          AND legacy_quote_id IS NULL
          AND legacy_engine_task_id IS NULL
        )
        OR (
          ingress_origin = 'BACKEND_POSTGRESQL'
          AND ingress_contract_version = 1
          AND card_token_contract_version = 1
          AND legacy_import_batch_id IS NULL
          AND legacy_source_row_sha256 IS NULL
          AND legacy_import_disposition IS NULL
          AND legacy_lead_submission_id IS NULL
          AND legacy_poster_auth_user_id IS NULL
          AND legacy_quote_id IS NULL
          AND legacy_engine_task_id IS NULL
          AND (
            (ip_hash IS NULL AND ip_hash_scheme IS NULL)
            OR (ip_hash IS NOT NULL AND ip_hash_scheme = 'HMAC_SHA256_V1')
          )
        )
        OR (
          ingress_origin = 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC'
          AND ingress_contract_version = 0
          AND card_token_contract_version = 0
          AND legacy_import_batch_id IS NOT NULL
          AND legacy_source_row_sha256 IS NOT NULL
          AND legacy_import_disposition IS NOT NULL
          AND (
            ip_hash IS NULL
            OR ip_hash_scheme IN (
              'LEGACY_SHA256_IP_SUFFIX_V1',
              'HMAC_SHA256_V1'
            )
          )
        )
      ) NOT VALID;
  END IF;
END
$$;

-- Backfill only the newly introduced compatibility metadata. Universal V1
-- rows can only have entered through the canonical backend; version-zero rows
-- intentionally remain unclassified. No legacy source or canonical FK is
-- inferred from coincidental UUID equality.
UPDATE public.task_drafts
SET ingress_contract_version = CASE
      WHEN universal_contract_version = 1 THEN 1 ELSE 0
    END,
    ingress_origin = CASE
      WHEN universal_contract_version = 1 THEN 'BACKEND_POSTGRESQL'
      ELSE 'UNCLASSIFIED_V0'
    END,
    card_token_contract_version = CASE
      WHEN universal_contract_version = 1 THEN 1 ELSE 0
    END,
    ip_hash_scheme = CASE
      WHEN ip_hash IS NULL THEN NULL
      WHEN universal_contract_version = 1 THEN 'HMAC_SHA256_V1'
      ELSE 'UNKNOWN_V0'
    END
WHERE ingress_origin = 'UNCLASSIFIED_V0'
  AND ingress_contract_version = 0
  AND card_token_contract_version = 0
  AND legacy_import_batch_id IS NULL;

ALTER TABLE public.task_drafts
  VALIDATE CONSTRAINT task_drafts_ingress_contract_version_check,
  VALIDATE CONSTRAINT task_drafts_ingress_origin_check,
  VALIDATE CONSTRAINT task_drafts_card_token_contract_version_check,
  VALIDATE CONSTRAINT task_drafts_ip_hash_scheme_check,
  VALIDATE CONSTRAINT task_drafts_ip_hash_presence_check,
  VALIDATE CONSTRAINT task_drafts_legacy_source_row_sha256_check,
  VALIDATE CONSTRAINT task_drafts_legacy_import_disposition_check,
  VALIDATE CONSTRAINT task_drafts_ingress_origin_evidence_check;

-- Rate-limit continuity is keyed by both the declared hashing scheme and the
-- hash. An import batch must separately prove dual-scheme secret reference,
-- one-hour drain, or fail-closed policy before the legacy writer is disabled.
CREATE INDEX IF NOT EXISTS idx_task_drafts_ingress_rate_window
  ON public.task_drafts(ip_hash_scheme, ip_hash, created_at DESC)
  WHERE ip_hash IS NOT NULL;

-- One receipt records one source-row disposition at the import boundary. A
-- receipt can reference a newly inserted read-only TaskDraft, but cannot claim
-- that a route or canonical foreign-key relationship was synthesized.
CREATE TABLE IF NOT EXISTS public.task_draft_legacy_import_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL
    REFERENCES public.task_draft_legacy_import_batches(id) ON DELETE RESTRICT,
  source_row_sha256 CHAR(64) NOT NULL CHECK (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  target_row_sha256 CHAR(64) CHECK (
    target_row_sha256 IS NULL OR target_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_submission_id UUID NOT NULL,
  source_card_token_hash CHAR(64) NOT NULL CHECK (
    source_card_token_hash ~ '^[0-9a-f]{64}$'
  ),
  target_card_token_hash CHAR(64) CHECK (
    target_card_token_hash IS NULL OR target_card_token_hash ~ '^[0-9a-f]{64}$'
  ),
  legacy_lead_submission_id UUID,
  legacy_poster_auth_user_id UUID,
  legacy_quote_id UUID,
  legacy_engine_task_id TEXT,
  target_task_draft_id UUID UNIQUE
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  import_disposition TEXT NOT NULL CHECK (
    import_disposition IN (
      'IMPORTED_READ_ONLY',
      'RESUMABLE_AFTER_EXPLICIT_PROOF',
      'UNRESOLVED',
      'UNVERIFIED',
      'QUARANTINED'
    )
  ),
  lead_disposition TEXT NOT NULL CHECK (
    lead_disposition IN (
      'UNRESOLVED',
      'LEGACY_REFERENCE_ONLY',
      'VERIFIED_EXACT_REFERENCE',
      'QUARANTINED'
    )
  ),
  token_disposition TEXT NOT NULL CHECK (
    token_disposition IN (
      'UNVERIFIED',
      'HASH_ONLY_READ_ONLY',
      'VERIFIED_FOR_FUTURE_REHASH',
      'QUARANTINED'
    )
  ),
  route_disposition TEXT NOT NULL CHECK (
    route_disposition IN (
      'NO_SYNTHETIC_ROUTE',
      'EXPLICIT_APPLICATION_ADOPTION_REQUIRED',
      'QUARANTINED'
    )
  ),
  reason_codes TEXT[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  recorded_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (import_batch_id, source_row_sha256),
  UNIQUE (import_batch_id, source_submission_id),
  CHECK (
    (
      import_disposition IN (
        'IMPORTED_READ_ONLY',
        'RESUMABLE_AFTER_EXPLICIT_PROOF'
      )
      AND target_task_draft_id IS NOT NULL
      AND target_row_sha256 IS NOT NULL
      AND target_card_token_hash IS NOT NULL
      AND route_disposition IN (
        'NO_SYNTHETIC_ROUTE',
        'EXPLICIT_APPLICATION_ADOPTION_REQUIRED'
      )
    )
    OR import_disposition IN (
      'UNRESOLVED',
      'UNVERIFIED',
      'QUARANTINED'
    )
  ),
  CHECK (
    lead_disposition <> 'VERIFIED_EXACT_REFERENCE'
    OR legacy_lead_submission_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_task_draft_legacy_receipts_target
  ON public.task_draft_legacy_import_receipts(target_task_draft_id)
  WHERE target_task_draft_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_task_draft_legacy_import_receipt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  imported_draft public.task_drafts%ROWTYPE;
BEGIN
  IF NEW.target_task_draft_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO imported_draft
  FROM public.task_drafts
  WHERE id = NEW.target_task_draft_id;

  IF NOT FOUND
     OR imported_draft.ingress_origin <> 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC'
     OR imported_draft.ingress_contract_version <> 0
     OR imported_draft.card_token_contract_version <> 0
     OR imported_draft.universal_contract_version <> 0
     OR imported_draft.legacy_import_batch_id IS DISTINCT FROM NEW.import_batch_id
     OR imported_draft.legacy_source_row_sha256 IS DISTINCT FROM NEW.source_row_sha256
     OR imported_draft.submission_id IS DISTINCT FROM NEW.source_submission_id
     OR imported_draft.card_token_hash IS DISTINCT FROM NEW.target_card_token_hash
     OR imported_draft.legacy_lead_submission_id
          IS DISTINCT FROM NEW.legacy_lead_submission_id
     OR imported_draft.legacy_poster_auth_user_id
          IS DISTINCT FROM NEW.legacy_poster_auth_user_id
     OR imported_draft.legacy_quote_id IS DISTINCT FROM NEW.legacy_quote_id
     OR imported_draft.legacy_engine_task_id IS DISTINCT FROM NEW.legacy_engine_task_id
     OR imported_draft.lead_id IS NOT NULL
     OR imported_draft.poster_user_id IS NOT NULL
     OR imported_draft.task_id IS NOT NULL
     OR imported_draft.quote_id IS NOT NULL
     OR imported_draft.active_routing_decision_id IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM public.task_routing_decisions routing
       WHERE routing.task_draft_id = imported_draft.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-TD-LEGACY-2: imported TaskDraft must remain an exact read-only v0 row without canonical links or routes'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_legacy_import_receipt_guard
  ON public.task_draft_legacy_import_receipts;
CREATE TRIGGER task_draft_legacy_import_receipt_guard
BEFORE INSERT ON public.task_draft_legacy_import_receipts
FOR EACH ROW EXECUTE FUNCTION enforce_task_draft_legacy_import_receipt();

-- Compatibility identity is insert-once. In particular, an imported legacy
-- row is a read-only evidence projection: it cannot later gain a canonical
-- lead, user, quote, task, route, or Universal V1 authority by coincidence.
-- A future explicit-adoption contract must replace this guard deliberately.
CREATE OR REPLACE FUNCTION enforce_task_draft_ingress_compatibility_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.ingress_origin = 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC' THEN
      RAISE EXCEPTION 'HXUV1-TD-LEGACY-3: imported TaskDraft evidence is read-only pending an explicit adoption contract'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.ingress_origin = 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC' THEN
    RAISE EXCEPTION 'HXUV1-TD-LEGACY-3: imported TaskDraft evidence is read-only pending an explicit adoption contract'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.ingress_contract_version IS DISTINCT FROM NEW.ingress_contract_version
     OR OLD.ingress_origin IS DISTINCT FROM NEW.ingress_origin
     OR OLD.card_token_contract_version IS DISTINCT FROM NEW.card_token_contract_version
     OR OLD.card_token_hash IS DISTINCT FROM NEW.card_token_hash
     OR OLD.ip_hash_scheme IS DISTINCT FROM NEW.ip_hash_scheme
     OR OLD.ip_hash IS DISTINCT FROM NEW.ip_hash
     OR OLD.legacy_lead_submission_id IS DISTINCT FROM NEW.legacy_lead_submission_id
     OR OLD.legacy_poster_auth_user_id IS DISTINCT FROM NEW.legacy_poster_auth_user_id
     OR OLD.legacy_quote_id IS DISTINCT FROM NEW.legacy_quote_id
     OR OLD.legacy_engine_task_id IS DISTINCT FROM NEW.legacy_engine_task_id
     OR OLD.legacy_import_batch_id IS DISTINCT FROM NEW.legacy_import_batch_id
     OR OLD.legacy_source_row_sha256 IS DISTINCT FROM NEW.legacy_source_row_sha256
     OR OLD.legacy_import_disposition IS DISTINCT FROM NEW.legacy_import_disposition THEN
    RAISE EXCEPTION 'HXUV1-TD-LEGACY-4: TaskDraft ingress compatibility identity is immutable after insert'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_ingress_compatibility_immutable
  ON public.task_drafts;
CREATE TRIGGER task_draft_ingress_compatibility_immutable
BEFORE UPDATE OR DELETE ON public.task_drafts
FOR EACH ROW EXECUTE FUNCTION enforce_task_draft_ingress_compatibility_immutability();

-- A legacy TaskDraft and its immutable receipt are inserted in the same
-- transaction. The deferred check allows either insert order while refusing
-- an orphan source row at commit.
CREATE OR REPLACE FUNCTION enforce_task_draft_legacy_receipt_presence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ingress_origin <> 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.task_draft_legacy_import_receipts receipt
    WHERE receipt.target_task_draft_id = NEW.id
      AND receipt.import_batch_id = NEW.legacy_import_batch_id
      AND receipt.source_row_sha256 = NEW.legacy_source_row_sha256
      AND receipt.source_submission_id = NEW.submission_id
      AND receipt.target_card_token_hash = NEW.card_token_hash
      AND receipt.import_disposition = NEW.legacy_import_disposition
      AND receipt.legacy_lead_submission_id
            IS NOT DISTINCT FROM NEW.legacy_lead_submission_id
      AND receipt.legacy_poster_auth_user_id
            IS NOT DISTINCT FROM NEW.legacy_poster_auth_user_id
      AND receipt.legacy_quote_id IS NOT DISTINCT FROM NEW.legacy_quote_id
      AND receipt.legacy_engine_task_id IS NOT DISTINCT FROM NEW.legacy_engine_task_id
      AND receipt.route_disposition IN (
        'NO_SYNTHETIC_ROUTE',
        'EXPLICIT_APPLICATION_ADOPTION_REQUIRED'
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-TD-LEGACY-5: imported TaskDraft requires its exact immutable receipt by commit'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_legacy_import_receipt_presence_guard
  ON public.task_drafts;
CREATE CONSTRAINT TRIGGER task_draft_legacy_import_receipt_presence_guard
AFTER INSERT ON public.task_drafts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_task_draft_legacy_receipt_presence();

CREATE OR REPLACE FUNCTION prevent_task_draft_legacy_import_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-TD-LEGACY-1: TaskDraft legacy import evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS task_draft_legacy_import_batches_immutable
  ON public.task_draft_legacy_import_batches;
CREATE TRIGGER task_draft_legacy_import_batches_immutable
BEFORE UPDATE OR DELETE ON public.task_draft_legacy_import_batches
FOR EACH ROW EXECUTE FUNCTION prevent_task_draft_legacy_import_evidence_mutation();

DROP TRIGGER IF EXISTS task_draft_legacy_import_batches_no_truncate
  ON public.task_draft_legacy_import_batches;
CREATE TRIGGER task_draft_legacy_import_batches_no_truncate
BEFORE TRUNCATE ON public.task_draft_legacy_import_batches
FOR EACH STATEMENT EXECUTE FUNCTION prevent_task_draft_legacy_import_evidence_mutation();

DROP TRIGGER IF EXISTS task_draft_legacy_import_receipts_immutable
  ON public.task_draft_legacy_import_receipts;
CREATE TRIGGER task_draft_legacy_import_receipts_immutable
BEFORE UPDATE OR DELETE ON public.task_draft_legacy_import_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_task_draft_legacy_import_evidence_mutation();

DROP TRIGGER IF EXISTS task_draft_legacy_import_receipts_no_truncate
  ON public.task_draft_legacy_import_receipts;
CREATE TRIGGER task_draft_legacy_import_receipts_no_truncate
BEFORE TRUNCATE ON public.task_draft_legacy_import_receipts
FOR EACH STATEMENT EXECUTE FUNCTION prevent_task_draft_legacy_import_evidence_mutation();

REVOKE ALL ON TABLE public.task_draft_legacy_import_batches FROM PUBLIC;
REVOKE ALL ON TABLE public.task_draft_legacy_import_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_task_draft_legacy_import_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_task_draft_ingress_compatibility_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_task_draft_legacy_receipt_presence() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_task_draft_legacy_import_evidence_mutation() FROM PUBLIC;

COMMENT ON COLUMN public.task_drafts.ingress_origin IS
  'Immutable-origin classification: unknown v0, canonical backend, or reviewed legacy Supabase import.';
COMMENT ON COLUMN public.task_drafts.legacy_lead_submission_id IS
  'Legacy external lead submission identifier only; it is not the canonical leads.id foreign key.';
COMMENT ON COLUMN public.task_drafts.legacy_poster_auth_user_id IS
  'Legacy external auth identifier only; it is not the canonical users.id foreign key.';
COMMENT ON COLUMN public.task_drafts.legacy_quote_id IS
  'Legacy external quote identifier only; it is not the canonical quotes.id authority.';
COMMENT ON COLUMN public.task_drafts.legacy_engine_task_id IS
  'Legacy external engine task identifier only; it is not the canonical tasks.id authority.';
COMMENT ON TABLE public.task_draft_legacy_import_batches IS
  'Immutable reviewed manifests for read-only legacy task-draft-public import; no routing authority.';
COMMENT ON TABLE public.task_draft_legacy_import_receipts IS
  'Immutable hash-only row dispositions at the legacy import boundary; no synthetic routes or canonical FK guesses.';
