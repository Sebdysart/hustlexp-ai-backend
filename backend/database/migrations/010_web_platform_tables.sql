-- ============================================================================
-- Migration 010: Unified Web + iOS Platform Tables
-- Replaces Supabase. Single schema for all surfaces — no web_ prefix,
-- no separate ops tables. One user is one user regardless of surface.
-- ============================================================================

-- ── leads ────────────────────────────────────────────────────────────────────
-- Replaces BOTH Supabase web_leads AND ops_hustlers.
-- A lead is any person who expressed interest before authenticating.
-- lead_type distinguishes poster / hustler / business / founder.
-- user_id is NULL until they create a real account (iOS or web).
-- When a hustler signs up on iOS → UPDATE leads SET user_id = $uid WHERE email = $email.

CREATE TABLE IF NOT EXISTS leads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id     UUID        NOT NULL UNIQUE,
  lead_type         TEXT        NOT NULL CHECK (lead_type IN ('poster','hustler','business','founder')),
  email             TEXT        NOT NULL,
  name              TEXT,
  phone             TEXT,
  region            TEXT,
  zip               TEXT,
  answers           JSONB       NOT NULL DEFAULT '{}',
  utm               JSONB,
  status            TEXT        NOT NULL DEFAULT 'new',
  notes             TEXT,
  assigned_to       TEXT,
  source            TEXT        NOT NULL DEFAULT 'website',
  consent_version   TEXT        NOT NULL DEFAULT 'v1',
  ip_hash           TEXT,
  user_agent_hash   TEXT,
  correlation_id    TEXT,

  -- Hustler-specific (used when lead_type = 'hustler')
  home_zip          TEXT,
  radius_miles      INTEGER,
  vehicle           TEXT        NOT NULL DEFAULT 'none',
  max_lift_lbs      INTEGER,
  trust_tier        INTEGER     NOT NULL DEFAULT 0,
  checkr_status     TEXT        NOT NULL DEFAULT 'none',
  available         BOOLEAN     NOT NULL DEFAULT true,
  availability_note TEXT,
  skills            TEXT[]      NOT NULL DEFAULT '{}',
  completed_jobs    INTEGER     NOT NULL DEFAULT 0,
  cancel_count      INTEGER     NOT NULL DEFAULT 0,
  rating_avg        NUMERIC,
  response_minutes  INTEGER,

  -- Set when lead authenticates and becomes a real user
  user_id           UUID        REFERENCES users(id),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_leads_email     ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status    ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_lead_type ON leads(lead_type);
CREATE INDEX IF NOT EXISTS idx_leads_user_id   ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_created   ON leads(created_at DESC);

-- ── surveys ───────────────────────────────────────────────────────────────────
-- Anonymous research submissions. Separate from leads because they
-- have a different schema and purpose (research, not CRM).

CREATE TABLE IF NOT EXISTS surveys (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id    UUID        NOT NULL UNIQUE,
  role             TEXT        NOT NULL CHECK (role IN ('customer','hustler','waitlist')),
  email            TEXT,
  phone            TEXT,
  name             TEXT,
  region           TEXT,
  country          TEXT,
  zip_code         TEXT,
  intent_tags      TEXT[]      NOT NULL DEFAULT '{}',
  raw_payload      JSONB       NOT NULL DEFAULT '{}',
  utm              JSONB       NOT NULL DEFAULT '{}',
  consent_version  TEXT,
  status           TEXT        NOT NULL DEFAULT 'new',
  source           TEXT        NOT NULL DEFAULT 'website',
  ip_hash          TEXT,
  user_agent_hash  TEXT,
  correlation_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_surveys_email   ON surveys(email);
CREATE INDEX IF NOT EXISTS idx_surveys_role    ON surveys(role);
CREATE INDEX IF NOT EXISTS idx_surveys_created ON surveys(created_at DESC);

-- ── task_drafts ───────────────────────────────────────────────────────────────
-- Anonymous pre-auth task descriptions (from /get-help).
-- Deliberately separate from tasks because:
--   1. No poster_id required (anonymous)
--   2. Different fields (raw_input, token hash, price estimates)
--   3. Financial invariants on tasks don't apply here
--   4. A draft only becomes a task when the poster authenticates + pays
-- task_id is populated on conversion draft → real task.

CREATE TABLE IF NOT EXISTS task_drafts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id        UUID        NOT NULL UNIQUE,
  card_token_hash      TEXT        NOT NULL UNIQUE,
  category             TEXT        NOT NULL DEFAULT 'other',
  title                TEXT,
  raw_input            TEXT        NOT NULL,
  scope_summary        TEXT,
  structured           JSONB       NOT NULL DEFAULT '{}',
  est_price_min_cents  INTEGER,
  est_price_max_cents  INTEGER,
  photo_count          INTEGER     NOT NULL DEFAULT 0,
  zip                  TEXT,
  region               TEXT,
  status               TEXT        NOT NULL DEFAULT 'draft',
  source               TEXT        NOT NULL DEFAULT 'get_help_v2',
  utm                  JSONB       NOT NULL DEFAULT '{}',
  ip_hash              TEXT,

  -- Foreign keys — both nullable: set as the draft progresses
  lead_id              UUID        REFERENCES leads(id),
  poster_user_id       UUID        REFERENCES users(id),
  task_id              UUID        REFERENCES tasks(id), -- set on conversion
  quote_id             UUID,                             -- set when quoted

  claimed_at           TIMESTAMPTZ,
  quote_send_ready_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_drafts_status  ON task_drafts(status);
CREATE INDEX IF NOT EXISTS idx_task_drafts_lead    ON task_drafts(lead_id);
CREATE INDEX IF NOT EXISTS idx_task_drafts_user    ON task_drafts(poster_user_id);
CREATE INDEX IF NOT EXISTS idx_task_drafts_token   ON task_drafts(card_token_hash);

-- ── action_links ──────────────────────────────────────────────────────────────
-- Job cards sent to hustlers and posters.
-- Linked to tasks (real tasks) and leads (pre-auth hustlers).
-- No web_ prefix — this is a core product concept for both surfaces.

CREATE TABLE IF NOT EXISTS action_links (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  link_type      TEXT        NOT NULL CHECK (link_type IN ('hustler_activation','poster_scope')),
  role           TEXT        NOT NULL CHECK (role IN ('hustler','poster')),

  -- At least one of these should be set depending on the stage
  lead_id        UUID        REFERENCES leads(id),
  user_id        UUID        REFERENCES users(id),
  task_id        UUID        REFERENCES tasks(id),
  task_draft_id  UUID        REFERENCES task_drafts(id),
  quote_id       UUID,

  token_hash      TEXT        NOT NULL UNIQUE,
  allowed_actions TEXT[]      NOT NULL DEFAULT '{}',
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'link_created',
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_opened_at  TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_links_token   ON action_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_action_links_status  ON action_links(status);
CREATE INDEX IF NOT EXISTS idx_action_links_lead    ON action_links(lead_id);
CREATE INDEX IF NOT EXISTS idx_action_links_user    ON action_links(user_id);
CREATE INDEX IF NOT EXISTS idx_action_links_task    ON action_links(task_id);

CREATE TABLE IF NOT EXISTS action_link_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_link_id UUID        NOT NULL REFERENCES action_links(id),
  event_type     TEXT        NOT NULL,
  payload        JSONB       NOT NULL DEFAULT '{}',
  ip_hash        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_link_events_link ON action_link_events(action_link_id);

-- ── quotes ────────────────────────────────────────────────────────────────────
-- Ops pricing before escrow. Links to task_drafts and eventually tasks.

CREATE TABLE IF NOT EXISTS quotes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           UUID        REFERENCES leads(id),
  task_draft_id     UUID        REFERENCES task_drafts(id),
  task_id           UUID        REFERENCES tasks(id),
  title             TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'draft',
  active_version_id UUID,
  negotiation_status TEXT       NOT NULL DEFAULT 'none',
  locked_at         TIMESTAMPTZ,
  lost_reason       TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_versions (
  id                             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id                       UUID        NOT NULL REFERENCES quotes(id),
  version_number                 INTEGER     NOT NULL,
  status                         TEXT        NOT NULL DEFAULT 'draft',
  customer_description           TEXT        NOT NULL,
  internal_notes                 TEXT,
  subtotal_cents                 INTEGER     NOT NULL DEFAULT 0,
  service_fee_cents              INTEGER     NOT NULL DEFAULT 0,
  materials_cents                INTEGER     NOT NULL DEFAULT 0,
  discount_cents                 INTEGER     NOT NULL DEFAULT 0,
  total_cents                    INTEGER     NOT NULL,
  minimum_acceptable_price_cents INTEGER,
  hustler_payout_cents           INTEGER,
  platform_margin_cents          INTEGER,
  scope_json                     JSONB       NOT NULL DEFAULT '{}',
  pay_token                      TEXT        NOT NULL,
  stripe_payment_link_url        TEXT,
  stripe_checkout_session_id     TEXT,
  stripe_payment_intent_id       TEXT,
  stripe_mode                    TEXT        NOT NULL DEFAULT 'test',
  paid_at                        TIMESTAMPTZ,
  created_by                     TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotes_lead       ON quotes(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status     ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quote_versions_q  ON quote_versions(quote_id);

-- ── feature_flags ─────────────────────────────────────────────────────────────
-- Used by FlagsService (flagsRouter) for iOS app + web platform flags.

CREATE TABLE IF NOT EXISTS feature_flags (
  name               TEXT        PRIMARY KEY,
  enabled            BOOLEAN     NOT NULL DEFAULT false,
  rollout_percentage INTEGER     NOT NULL DEFAULT 100,
  user_allowlist     TEXT[]      NOT NULL DEFAULT '{}',
  user_blocklist     TEXT[]      NOT NULL DEFAULT '{}',
  metadata           JSONB       NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (name, enabled)
SELECT name, enabled FROM (VALUES
  ('native_survey',                          true),
  ('get_help_v2',                            false),
  ('earn_v2',                                false),
  ('supply_contract_enabled',                false),
  ('dispatch_candidates_enabled',            false),
  ('hustler_activation_enabled',             false),
  ('manual_assignment_enabled',              false),
  ('taskcard_secure_payment_enabled',        false),
  ('taskcard_release_preview_enabled',       false),
  ('taskcard_transfer_reversal_enabled',     false),
  ('taskcard_match_window_guarantee_enabled',false),
  ('taskcard_auto_release_enabled',          false),
  ('taskcard_capture_enabled',               false)
) AS v(name, enabled)
WHERE NOT EXISTS (
  SELECT 1 FROM feature_flags WHERE feature_flags.name = v.name
);
