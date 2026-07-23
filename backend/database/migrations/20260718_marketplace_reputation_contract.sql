-- HustleXP marketplace reputation contract.
-- Verified work, transaction reviews, unverified local recommendations,
-- credentials, and XP remain separate signals. No earnings are exposed.

CREATE TABLE IF NOT EXISTS verified_region_memberships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  verification_method TEXT NOT NULL CHECK (verification_method IN ('ADDRESS_PROVIDER','DOCUMENT_REVIEW')),
  verification_ref_hash CHAR(64) NOT NULL CHECK (verification_ref_hash ~ '^[a-f0-9]{64}$'),
  verified_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','REVOKED','EXPIRED')),
  PRIMARY KEY (user_id, region_code),
  CHECK (expires_at IS NULL OR expires_at > verified_at)
);

CREATE TABLE IF NOT EXISTS local_provider_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommender_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category ~ '^[a-z0-9_-]{1,100}$'),
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  body TEXT NOT NULL CHECK (LENGTH(body) BETWEEN 10 AND 500),
  relationship TEXT NOT NULL CHECK (relationship IN ('NEIGHBOR','CUSTOMER','COMMUNITY_MEMBER')),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  state TEXT NOT NULL DEFAULT 'PENDING_MODERATION'
    CHECK (state IN ('PENDING_MODERATION','HELD_FOR_REVIEW','PUBLISHED','REJECTED','REMOVED')),
  collusion_hold BOOLEAN NOT NULL DEFAULT FALSE,
  moderated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  moderation_reason TEXT CHECK (moderation_reason IS NULL OR LENGTH(moderation_reason) BETWEEN 20 AND 1000),
  moderated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recommender_id, idempotency_key),
  UNIQUE (recommender_id, provider_user_id, category, region_code),
  CHECK (recommender_id <> provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_local_provider_recommendations_public
  ON local_provider_recommendations(provider_user_id, category, region_code, created_at DESC)
  WHERE state = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS idx_local_provider_recommendations_moderation
  ON local_provider_recommendations(state, created_at)
  WHERE state IN ('PENDING_MODERATION','HELD_FOR_REVIEW');

CREATE TABLE IF NOT EXISTS provider_credential_status (
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category ~ '^[a-z0-9_-]{1,100}$'),
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  license_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (license_status IN ('VERIFIED','UNVERIFIED','NOT_REQUIRED','EXPIRED')),
  insurance_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (insurance_status IN ('VERIFIED','UNVERIFIED','NOT_REQUIRED','EXPIRED')),
  background_check_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (background_check_status IN ('VERIFIED','UNVERIFIED','NOT_REQUIRED','EXPIRED')),
  verification_source TEXT,
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  updated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_user_id, category, region_code)
);

CREATE TABLE IF NOT EXISTS reputation_signal_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  related_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category ~ '^[a-z0-9_-]{1,100}$'),
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  signal_type TEXT NOT NULL CHECK (signal_type IN ('TRANSACTION_REVIEW','LOCAL_RECOMMENDATION')),
  source_id UUID NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'RECIPROCAL_RECOMMENDATION','REPEAT_PAIR_CONCENTRATION','RATING_BURST','SHARED_DEVICE_OR_PAYMENT'
  )),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','DISMISSED')),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  review_reason TEXT CHECK (review_reason IS NULL OR LENGTH(review_reason) BETWEEN 20 AND 1000),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (signal_type, source_id, reason_code)
);

CREATE INDEX IF NOT EXISTS idx_reputation_signal_flags_provider
  ON reputation_signal_flags(provider_user_id, category, region_code, status, created_at DESC);

CREATE TABLE IF NOT EXISTS reputation_signal_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID NOT NULL REFERENCES reputation_signal_flags(id) ON DELETE RESTRICT,
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (LENGTH(reason) BETWEEN 20 AND 1000),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','UPHELD','OVERTURNED')),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  review_reason TEXT CHECK (review_reason IS NULL OR LENGTH(review_reason) BETWEEN 20 AND 1000),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (signal_id, provider_user_id)
);

CREATE OR REPLACE FUNCTION enforce_local_recommendation_contract()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HXREP4: local recommendation records cannot be deleted' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.recommender_id = NEW.provider_user_id THEN
      RAISE EXCEPTION 'HXREP1: self-recommendation is forbidden' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM verified_region_memberships m
       WHERE m.user_id = NEW.recommender_id AND m.region_code = NEW.region_code
         AND m.state = 'ACTIVE' AND (m.expires_at IS NULL OR m.expires_at > NOW())
    ) THEN
      RAISE EXCEPTION 'HXREP2: active verified-local membership is required' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.collusion_hold AND NEW.state <> 'HELD_FOR_REVIEW')
       OR (NOT NEW.collusion_hold AND NEW.state <> 'PENDING_MODERATION') THEN
      RAISE EXCEPTION 'HXREP5: new recommendations require moderation or a collusion hold' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.recommender_id IS DISTINCT FROM NEW.recommender_id
     OR OLD.provider_user_id IS DISTINCT FROM NEW.provider_user_id
     OR OLD.category IS DISTINCT FROM NEW.category
     OR OLD.region_code IS DISTINCT FROM NEW.region_code
     OR OLD.body IS DISTINCT FROM NEW.body
     OR OLD.relationship IS DISTINCT FROM NEW.relationship
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.collusion_hold IS DISTINCT FROM NEW.collusion_hold
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'HXREP3: recommendation identity and content are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (
    (OLD.state IN ('PENDING_MODERATION','HELD_FOR_REVIEW') AND NEW.state IN ('PUBLISHED','REJECTED'))
    OR (OLD.state = 'PUBLISHED' AND NEW.state = 'REMOVED')
  ) THEN
    RAISE EXCEPTION 'HXREP5: invalid recommendation moderation transition' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.moderated_by IS NULL OR NEW.moderated_at IS NULL OR NEW.moderation_reason IS NULL THEN
    RAISE EXCEPTION 'HXREP5: moderation requires actor, time, and reason' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS local_recommendation_contract_gate ON local_provider_recommendations;
CREATE TRIGGER local_recommendation_contract_gate
  BEFORE INSERT OR UPDATE OR DELETE ON local_provider_recommendations
  FOR EACH ROW EXECUTE FUNCTION enforce_local_recommendation_contract();

CREATE OR REPLACE FUNCTION enforce_reputation_appeal_contract()
RETURNS TRIGGER AS $$
DECLARE
  signal_provider UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HXREP4: reputation appeals cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT provider_user_id INTO signal_provider FROM reputation_signal_flags WHERE id = NEW.signal_id;
    IF signal_provider IS NULL OR signal_provider <> NEW.provider_user_id THEN
      RAISE EXCEPTION 'HXREP2: only the affected provider may appeal' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.signal_id IS DISTINCT FROM NEW.signal_id
     OR OLD.provider_user_id IS DISTINCT FROM NEW.provider_user_id
     OR OLD.reason IS DISTINCT FROM NEW.reason
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.status <> 'PENDING'
     OR NEW.status NOT IN ('UPHELD','OVERTURNED') THEN
    RAISE EXCEPTION 'HXREP3: appeal content is immutable and review is final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR NEW.review_reason IS NULL THEN
    RAISE EXCEPTION 'HXREP5: appeal review requires actor, time, and reason' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reputation_appeal_contract_gate ON reputation_signal_appeals;
CREATE TRIGGER reputation_appeal_contract_gate
  BEFORE INSERT OR UPDATE OR DELETE ON reputation_signal_appeals
  FOR EACH ROW EXECUTE FUNCTION enforce_reputation_appeal_contract();

-- Canonical performance facts. Metrics without source evidence are not emitted
-- as false; the public policy leaves those fields unknown.
CREATE OR REPLACE VIEW provider_verified_performance_category AS
WITH base AS (
  SELECT t.id, t.worker_id AS provider_user_id, t.poster_id,
         COALESCE(NULLIF(t.trade_type, ''), NULLIF(t.category, ''), 'uncategorized') AS category,
         t.region_code, t.state
    FROM tasks t
   WHERE t.worker_id IS NOT NULL
     AND t.region_code IS NOT NULL
     AND t.automation_classification = 'PRODUCTION'
), pair_completions AS (
  SELECT provider_user_id, poster_id, category, region_code,
         COUNT(*) FILTER (WHERE state = 'COMPLETED') AS completed_together
    FROM base
   GROUP BY provider_user_id, poster_id, category, region_code
), repeat_counts AS (
  SELECT provider_user_id, category, region_code, COUNT(*) AS repeat_customer_count
    FROM pair_completions
   WHERE completed_together >= 2
   GROUP BY provider_user_id, category, region_code
)
SELECT b.provider_user_id, b.category, b.region_code,
       COUNT(*)::BIGINT AS verified_assignments,
       COUNT(*) FILTER (WHERE b.state = 'COMPLETED')::BIGINT AS verified_completions,
       CASE WHEN COUNT(*) FILTER (WHERE b.state IN ('COMPLETED','CANCELLED','EXPIRED')) = 0 THEN NULL
            ELSE COUNT(*) FILTER (WHERE b.state = 'COMPLETED')::NUMERIC
              / COUNT(*) FILTER (WHERE b.state IN ('COMPLETED','CANCELLED','EXPIRED')) END AS completion_rate,
       CASE WHEN COUNT(*) = 0 THEN NULL
            ELSE COUNT(*) FILTER (WHERE b.state IN ('CANCELLED','EXPIRED'))::NUMERIC / COUNT(*) END AS cancellation_rate,
       CASE WHEN COUNT(*) FILTER (WHERE b.state = 'COMPLETED') = 0 THEN NULL
            ELSE COUNT(*) FILTER (WHERE b.state = 'COMPLETED' AND EXISTS (
              SELECT 1 FROM proofs p WHERE p.task_id = b.id AND p.state = 'ACCEPTED'
            ))::NUMERIC / COUNT(*) FILTER (WHERE b.state = 'COMPLETED') END AS proof_completeness_rate,
       CASE WHEN COUNT(*) FILTER (WHERE b.state = 'COMPLETED') = 0 THEN NULL
            ELSE COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM disputes d WHERE d.task_id = b.id
            ))::NUMERIC / COUNT(*) FILTER (WHERE b.state = 'COMPLETED') END AS dispute_rate,
       COALESCE(MAX(rc.repeat_customer_count), 0)::BIGINT AS repeat_customer_count
  FROM base b
  LEFT JOIN repeat_counts rc USING (provider_user_id, category, region_code)
 GROUP BY b.provider_user_id, b.category, b.region_code;

-- Repeat-pair influence is capped by 1/rank and recent reviews use a 180-day
-- half-life. Confirmed manipulation flags remove the source from aggregation.
CREATE OR REPLACE VIEW provider_transaction_review_category AS
WITH eligible AS (
  SELECT r.id, r.rater_id, r.ratee_id AS provider_user_id,
         COALESCE(NULLIF(t.trade_type, ''), NULLIF(t.category, ''), 'uncategorized') AS category,
         t.region_code, r.stars, r.structured_feedback, r.created_at,
         ROW_NUMBER() OVER (
           PARTITION BY r.ratee_id, r.rater_id,
             COALESCE(NULLIF(t.trade_type, ''), NULLIF(t.category, ''), 'uncategorized'), t.region_code
           ORDER BY r.created_at DESC, r.id
         ) AS pair_rank
    FROM task_ratings r
    JOIN tasks t ON t.id = r.task_id
   WHERE t.state = 'COMPLETED'
     AND t.automation_classification = 'PRODUCTION'
     AND t.region_code IS NOT NULL
     AND r.rater_id = t.poster_id AND r.ratee_id = t.worker_id
     AND r.is_public = TRUE AND r.is_blind = FALSE AND r.is_auto_rated = FALSE
     AND r.structured_feedback IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM reputation_signal_flags f
        WHERE f.signal_type = 'TRANSACTION_REVIEW' AND f.source_id = r.id AND f.status = 'CONFIRMED'
     )
), weighted AS (
  SELECT *,
         POWER(2.0, -GREATEST(0, EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0) / 180.0)
           / pair_rank AS signal_weight
    FROM eligible
)
SELECT provider_user_id, category, region_code,
       COUNT(*)::BIGINT AS transaction_review_count,
       (SUM(stars * signal_weight) / NULLIF(SUM(signal_weight), 0))::NUMERIC(4,2) AS weighted_overall_rating,
       (SUM((structured_feedback->>'communication')::NUMERIC * signal_weight) / NULLIF(SUM(signal_weight), 0))::NUMERIC(4,2) AS communication,
       (SUM((structured_feedback->>'scopeAccuracy')::NUMERIC * signal_weight) / NULLIF(SUM(signal_weight), 0))::NUMERIC(4,2) AS scope_accuracy,
       (SUM((structured_feedback->>'punctuality')::NUMERIC * signal_weight) / NULLIF(SUM(signal_weight), 0))::NUMERIC(4,2) AS punctuality,
       (SUM((structured_feedback->>'care')::NUMERIC * signal_weight) / NULLIF(SUM(signal_weight), 0))::NUMERIC(4,2) AS care,
       (SUM((structured_feedback->>'resultQuality')::NUMERIC * signal_weight) / NULLIF(SUM(signal_weight), 0))::NUMERIC(4,2) AS result_quality,
       (SUM((structured_feedback->>'value')::NUMERIC * signal_weight) / NULLIF(SUM(signal_weight), 0))::NUMERIC(4,2) AS value
  FROM weighted
 GROUP BY provider_user_id, category, region_code;

CREATE OR REPLACE VIEW provider_local_recommendation_category AS
SELECT r.provider_user_id, r.category, r.region_code,
       COUNT(*)::BIGINT AS nearby_recommendation_count
  FROM local_provider_recommendations r
 WHERE r.state = 'PUBLISHED'
   AND NOT EXISTS (
     SELECT 1 FROM reputation_signal_flags f
      WHERE f.signal_type = 'LOCAL_RECOMMENDATION' AND f.source_id = r.id AND f.status = 'CONFIRMED'
   )
 GROUP BY r.provider_user_id, r.category, r.region_code;

CREATE OR REPLACE VIEW provider_reputation_public AS
WITH keys AS (
  SELECT provider_user_id, category, region_code FROM provider_verified_performance_category
  UNION
  SELECT provider_user_id, category, region_code FROM provider_transaction_review_category
  UNION
  SELECT provider_user_id, category, region_code FROM provider_local_recommendation_category
  UNION
  SELECT provider_user_id, category, region_code FROM provider_credential_status
), risk AS (
  SELECT provider_user_id, category, region_code,
         COUNT(*) FILTER (WHERE status = 'CONFIRMED')::BIGINT AS confirmed_risk_flags
    FROM reputation_signal_flags
   GROUP BY provider_user_id, category, region_code
)
SELECT k.provider_user_id, k.category, k.region_code,
       COALESCE(p.verified_assignments, 0)::BIGINT AS verified_assignments,
       COALESCE(p.verified_completions, 0)::BIGINT AS verified_completions,
       p.completion_rate, p.cancellation_rate, p.proof_completeness_rate, p.dispute_rate,
       COALESCE(p.repeat_customer_count, 0)::BIGINT AS repeat_customer_count,
       COALESCE(t.transaction_review_count, 0)::BIGINT AS transaction_review_count,
       t.weighted_overall_rating, t.communication, t.scope_accuracy, t.punctuality,
       t.care, t.result_quality, t.value,
       COALESCE(l.nearby_recommendation_count, 0)::BIGINT AS nearby_recommendation_count,
       FALSE AS blended_into_verified_score,
       COALESCE(r.confirmed_risk_flags, 0)::BIGINT AS confirmed_risk_flags,
       CASE WHEN COALESCE(p.verified_completions, 0) < 5 THEN 'BUILDING_HISTORY' ELSE 'ESTABLISHED' END AS experience_band,
       CASE WHEN COALESCE(p.verified_completions, 0) < 5 AND COALESCE(r.confirmed_risk_flags, 0) = 0
            THEN TRUE ELSE FALSE END AS exploration_eligible,
       COALESCE(CASE WHEN c.expires_at IS NOT NULL AND c.expires_at <= NOW() THEN 'EXPIRED' ELSE c.license_status END, 'UNVERIFIED') AS license_status,
       COALESCE(CASE WHEN c.expires_at IS NOT NULL AND c.expires_at <= NOW() THEN 'EXPIRED' ELSE c.insurance_status END, 'UNVERIFIED') AS insurance_status,
       COALESCE(CASE WHEN c.expires_at IS NOT NULL AND c.expires_at <= NOW() THEN 'EXPIRED' ELSE c.background_check_status END, 'UNVERIFIED') AS background_check_status
  FROM keys k
  LEFT JOIN provider_verified_performance_category p USING (provider_user_id, category, region_code)
  LEFT JOIN provider_transaction_review_category t USING (provider_user_id, category, region_code)
  LEFT JOIN provider_local_recommendation_category l USING (provider_user_id, category, region_code)
  LEFT JOIN risk r USING (provider_user_id, category, region_code)
  LEFT JOIN provider_credential_status c USING (provider_user_id, category, region_code);

COMMENT ON VIEW provider_reputation_public IS
  'Public-safe category and region reputation. Earnings and XP are deliberately excluded; local recommendations never blend into verified scores.';
