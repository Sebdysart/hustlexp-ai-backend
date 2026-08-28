BEGIN;

-- ============================================================================
-- TASK-SPECIFIC SUPPLY CONFIDENCE
-- ============================================================================
-- This is orchestration/read-model state only.
-- It does NOT create tasks, assignments, payments, payouts, or exact-location
-- lifecycle state.

CREATE TABLE IF NOT EXISTS public.task_supply_confidence (
  task_draft_id UUID PRIMARY KEY
    REFERENCES public.task_drafts(id)
    ON DELETE CASCADE,

  lead_id UUID NOT NULL
    REFERENCES public.leads(id)
    ON DELETE CASCADE,

  state TEXT NOT NULL
    CHECK (state IN ('CONFIDENT', 'BLOCKED', 'STALE')),

  confidence_source TEXT
    CHECK (
      confidence_source IS NULL
      OR confidence_source IN (
        'TASK_SOFT_AVAILABLE',
        'TASK_ELIGIBLE_POOL'
      )
    ),

  blockers TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

  demand JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(demand) = 'object'),

  required_worker_count INTEGER NOT NULL
    CHECK (required_worker_count BETWEEN 1 AND 8),

  candidate_count INTEGER NOT NULL DEFAULT 0
    CHECK (candidate_count >= 0),

  eligible_count INTEGER NOT NULL DEFAULT 0
    CHECK (eligible_count >= 0),

  soft_available_count INTEGER NOT NULL DEFAULT 0
    CHECK (soft_available_count >= 0),

  customer_price_cents INTEGER NOT NULL
    CHECK (customer_price_cents > 0),

  offered_payout_cents INTEGER NOT NULL
    CHECK (offered_payout_cents > 0),

  platform_margin_cents INTEGER NOT NULL
    CHECK (platform_margin_cents >= 0),

  input_fingerprint TEXT NOT NULL
    CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),

  next_automatic_action TEXT NOT NULL,

  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  valid_until TIMESTAMPTZ NOT NULL,

  policy_version TEXT NOT NULL
    DEFAULT 'task_supply_confidence_v1',

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Keep test/production lineage explicit.
  environment TEXT NOT NULL DEFAULT 'PRODUCTION'
    CHECK (environment IN ('TEST', 'PRODUCTION')),

  is_test BOOLEAN NOT NULL DEFAULT false,

  CHECK (
    environment =
      CASE WHEN is_test THEN 'TEST' ELSE 'PRODUCTION' END
  )
);

CREATE INDEX IF NOT EXISTS task_supply_confidence_due_idx
  ON public.task_supply_confidence(state, valid_until);


-- ============================================================================
-- PER-HUSTLER EVALUATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.task_supply_candidate_evaluations (
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id)
    ON DELETE CASCADE,

  hustler_id UUID NOT NULL
    REFERENCES public.users(id)
    ON DELETE CASCADE,

  input_fingerprint TEXT NOT NULL
    CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),

  eligible BOOLEAN NOT NULL DEFAULT false,

  soft_available_current BOOLEAN NOT NULL DEFAULT false,

  blockers TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

  evidence JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(evidence) = 'object'),

  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (task_draft_id, hustler_id)
);

CREATE INDEX IF NOT EXISTS task_supply_candidate_eligible_idx
  ON public.task_supply_candidate_evaluations(
    task_draft_id,
    eligible,
    soft_available_current
  );


-- ============================================================================
-- BOUNDED SUPPLY RECOVERY OUTBOX
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.task_supply_recovery_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id)
    ON DELETE CASCADE,

  lead_id UUID NOT NULL
    REFERENCES public.leads(id)
    ON DELETE CASCADE,

  action_kind TEXT NOT NULL
    CHECK (
      action_kind IN (
        'READINESS_REQUEST',
        'REACTIVATION_REQUEST',
        'REFERRAL_REQUEST',
        'POSTER_FALLBACK'
      )
    ),

  status TEXT NOT NULL DEFAULT 'READY'
    CHECK (
      status IN (
        'READY',
        'CLAIMED',
        'ENQUEUED',
        'COMPLETED',
        'SUPPRESSED',
        'FAILED_RETRYABLE',
        'FAILED_TERMINAL'
      )
    ),

  idempotency_key TEXT NOT NULL UNIQUE,

  input_fingerprint TEXT NOT NULL
    CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),

  scheduled_at TIMESTAMPTZ NOT NULL,

  quiet_hours_paused BOOLEAN NOT NULL DEFAULT false,

  poster_choices TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 10),

  claim_id UUID,

  claimed_at TIMESTAMPTZ,

  last_error_code TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_supply_recovery_due_idx
  ON public.task_supply_recovery_actions(status, scheduled_at)
  WHERE status IN ('READY', 'FAILED_RETRYABLE');


-- ============================================================================
-- COARSE ZIP DISTANCE
-- ============================================================================
-- Exact addresses never participate in supply-confidence evaluation.

CREATE OR REPLACE FUNCTION public.task_supply_zip_distance_miles_v1(
  p_a TEXT,
  p_b TEXT
)
RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH points(zip, lat, lon) AS (
    VALUES
      ('98004', 47.6101, -122.2015),
      ('98005', 47.6150, -122.1686),
      ('98006', 47.5579, -122.1541),
      ('98007', 47.6173, -122.1422),
      ('98008', 47.6051, -122.1162),
      ('98011', 47.7592, -122.2054),
      ('98024', 47.5668, -121.8883),
      ('98027', 47.5276, -122.0340),
      ('98029', 47.5570, -121.9990),
      ('98033', 47.6757, -122.1937),
      ('98034', 47.7204, -122.2070),
      ('98052', 47.6739, -122.1230),
      ('98053', 47.6697, -121.9960),
      ('98074', 47.6223, -122.0457),
      ('98075', 47.5861, -122.0409)
  ),
  pair AS (
    SELECT
      a.lat AS a_lat,
      a.lon AS a_lon,
      b.lat AS b_lat,
      b.lon AS b_lon
    FROM points a
    CROSS JOIN points b
    WHERE a.zip = left(coalesce(p_a, ''), 5)
      AND b.zip = left(coalesce(p_b, ''), 5)
  )
  SELECT round(
    sqrt(
      power((a_lat - b_lat) * 69.0, 2)
      + power((a_lon - b_lon) * 47.0, 2)
    )::numeric,
    2
  )
  FROM pair;
$fn$;


COMMENT ON TABLE public.task_supply_confidence IS
  'Current task-specific supply proof; never a global roster count and never an engine lifecycle.';

COMMENT ON TABLE public.task_supply_candidate_evaluations IS
  'Per-hustler deterministic supply evaluation for one task draft.';

COMMENT ON TABLE public.task_supply_recovery_actions IS
  'Bounded supply recovery outbox.';

COMMIT;