-- ============================================================================
-- EXPERTISE SUPPLY CONTROL v1.0.0
-- ============================================================================
-- Prevents supply/demand imbalance by capping hustlers per expertise per zone.
--
-- Core model: Weighted slot allocation
--   - Primary skill = 0.7 weight
--   - Secondary skill = 0.3 weight
--   - Max 2 skills per hustler in beta
--   - Hard cap + dynamic ratio-based gating
--
-- Liquidity ratio = completed_tasks_7d / effective_supply_weight (primary — real throughput)
-- Open ratio = open_tasks_7d / effective_supply_weight (secondary — responsiveness)
-- If liquidity_ratio < min_task_to_supply_ratio → block new hustlers
--
-- DoorDash, Uber, and Instacart do this quietly.
-- ============================================================================

-- ============================================================================
-- 1. EXPERTISE REGISTRY
-- ============================================================================
-- Defines all expertise types. Canonical source of truth.

CREATE TABLE IF NOT EXISTS expertise_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  risk_tier VARCHAR(20) NOT NULL DEFAULT 'LOW'
    CHECK (risk_tier IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial expertise categories for Seattle beta
INSERT INTO expertise_registry (slug, display_name, description, risk_tier, sort_order) VALUES
  ('general_labor',   'General Labor',     'Moving boxes, furniture assembly, yard work',   'LOW',    1),
  ('cleaning',        'Cleaning',          'House cleaning, deep cleaning, post-move cleanup', 'LOW', 2),
  ('moving_helper',   'Moving Helper',     'Help with moves, loading/unloading trucks',     'LOW',    3),
  ('errands',         'Errands',           'Grocery pickup, package delivery, returns',     'LOW',    4),
  ('pet_care',        'Pet Care',          'Dog walking, pet sitting, feeding',             'LOW',    5),
  ('tech_help',       'Tech Help',         'Computer setup, Wi-Fi troubleshooting, tutoring', 'MEDIUM', 6),
  ('handyman',        'Handyman',          'Minor repairs, painting, mounting',             'MEDIUM', 7),
  ('personal_assist', 'Personal Assistant', 'Event help, admin tasks, organization',        'MEDIUM', 8)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- 2. EXPERTISE CAPACITY (The Control Layer)
-- ============================================================================
-- Per-expertise, per-zone caps with ratio-based gating.
-- geo_zone is a coarse identifier (e.g., 'seattle_uw', 'seattle_ballard').
-- For beta: single zone 'seattle_metro'.

CREATE TABLE IF NOT EXISTS expertise_capacity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expertise_id UUID NOT NULL REFERENCES expertise_registry(id),
  geo_zone VARCHAR(50) NOT NULL DEFAULT 'seattle_metro',

  -- Hard cap: absolute max weighted supply
  max_weight_capacity NUMERIC(6,1) NOT NULL DEFAULT 25.0,

  -- Dynamic gate: minimum tasks-per-hustler ratio required to admit new supply
  min_task_to_supply_ratio NUMERIC(4,2) NOT NULL DEFAULT 2.0,

  -- Computed fields (updated by daily cron)
  current_weight NUMERIC(6,2) NOT NULL DEFAULT 0.0,
  active_hustlers INTEGER NOT NULL DEFAULT 0,
  open_tasks_7d INTEGER NOT NULL DEFAULT 0,
  completed_tasks_7d INTEGER NOT NULL DEFAULT 0, -- Primary throughput signal
  liquidity_ratio NUMERIC(6,2) NOT NULL DEFAULT 0.0, -- completed_tasks_7d / effective_weight (primary gate)
  open_ratio NUMERIC(6,2) NOT NULL DEFAULT 0.0,      -- open_tasks_7d / effective_weight (responsiveness signal)

  -- Auto-expansion: if p95 acceptance time > threshold, temporarily expand
  auto_expand_pct INTEGER NOT NULL DEFAULT 0, -- 0 = no expansion, 10 = +10%
  auto_expand_expires_at TIMESTAMPTZ,

  last_recalc_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(expertise_id, geo_zone)
);

-- Seed initial capacity for Seattle beta
-- Expected: ~100 low-risk tasks in 30 days → ~25 tasks/week → caps sized accordingly
INSERT INTO expertise_capacity (expertise_id, geo_zone, max_weight_capacity, min_task_to_supply_ratio)
SELECT id, 'seattle_metro',
  CASE slug
    WHEN 'general_labor'   THEN 25.0   -- Most common
    WHEN 'cleaning'        THEN 20.0
    WHEN 'moving_helper'   THEN 15.0
    WHEN 'errands'         THEN 20.0
    WHEN 'pet_care'        THEN 10.0
    WHEN 'tech_help'       THEN 10.0
    WHEN 'handyman'        THEN 10.0
    WHEN 'personal_assist' THEN 10.0
    ELSE 10.0
  END,
  2.0
FROM expertise_registry
ON CONFLICT (expertise_id, geo_zone) DO NOTHING;

-- ============================================================================
-- 3. USER EXPERTISE SELECTIONS
-- ============================================================================
-- Maps users to their selected expertise(s) with weight allocation.
-- Max 2 skills in beta. Primary = 0.7, Secondary = 0.3.
-- Skill changes locked for 30 days after last change.

CREATE TABLE IF NOT EXISTS user_expertise (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  expertise_id UUID NOT NULL REFERENCES expertise_registry(id),
  geo_zone VARCHAR(50) NOT NULL DEFAULT 'seattle_metro',

  -- Weight: 0.7 for primary, 0.3 for secondary
  slot_weight NUMERIC(3,2) NOT NULL DEFAULT 0.7
    CHECK (slot_weight IN (0.7, 0.3)),
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,

  -- Activity tracking (for decay calculation)
  last_task_accepted_at TIMESTAMPTZ,
  tasks_accepted_14d INTEGER NOT NULL DEFAULT 0,
  tasks_completed_14d INTEGER NOT NULL DEFAULT 0,

  -- Decay: effective_weight reduces if inactive
  effective_weight NUMERIC(4,3) NOT NULL DEFAULT 0.7,

  -- Change lock: cannot change expertise for 30 days
  locked_until TIMESTAMPTZ,

  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'suspended')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, expertise_id)
);

CREATE INDEX IF NOT EXISTS idx_user_expertise_user ON user_expertise(user_id);
CREATE INDEX IF NOT EXISTS idx_user_expertise_skill ON user_expertise(expertise_id, geo_zone);
CREATE INDEX IF NOT EXISTS idx_user_expertise_active ON user_expertise(expertise_id, geo_zone, status)
  WHERE status = 'active';

-- Constraint: max 2 expertise per user
CREATE OR REPLACE FUNCTION check_max_expertise()
RETURNS TRIGGER AS $$
BEGIN
  -- Advisory lock prevents TOCTOU race on concurrent inserts
  PERFORM pg_advisory_xact_lock(hashtext('user_expertise_' || NEW.user_id::text));
  IF (SELECT COUNT(*) FROM user_expertise WHERE user_id = NEW.user_id AND status = 'active') >= 2 THEN
    RAISE EXCEPTION 'HX801: Maximum 2 expertise categories allowed per user'
      USING ERRCODE = 'HX801';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_max_expertise ON user_expertise;
CREATE TRIGGER trg_check_max_expertise
  BEFORE INSERT ON user_expertise
  FOR EACH ROW
  EXECUTE FUNCTION check_max_expertise();

-- ============================================================================
-- 4. EXPERTISE WAITLIST
-- ============================================================================
-- FIFO queue. When cap is hit, user joins waitlist.
-- Auto-invited when ratio improves or slot opens.

CREATE TABLE IF NOT EXISTS expertise_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  expertise_id UUID NOT NULL REFERENCES expertise_registry(id),
  geo_zone VARCHAR(50) NOT NULL DEFAULT 'seattle_metro',

  -- Queue position
  position INTEGER NOT NULL,
  requested_weight NUMERIC(3,2) NOT NULL DEFAULT 0.7,

  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'invited', 'accepted', 'expired', 'cancelled')),

  -- Invitation tracking
  invited_at TIMESTAMPTZ,
  invite_expires_at TIMESTAMPTZ,  -- 48h to accept

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, expertise_id, geo_zone)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_skill_zone ON expertise_waitlist(expertise_id, geo_zone, status, position);
CREATE INDEX IF NOT EXISTS idx_waitlist_user ON expertise_waitlist(user_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_invited ON expertise_waitlist(status, invite_expires_at)
  WHERE status = 'invited';

-- Auto-assign queue position
CREATE OR REPLACE FUNCTION set_waitlist_position()
RETURNS TRIGGER AS $$
BEGIN
  NEW.position = COALESCE(
    (SELECT MAX(position) + 1
     FROM expertise_waitlist
     WHERE expertise_id = NEW.expertise_id AND geo_zone = NEW.geo_zone),
    1
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_waitlist_position ON expertise_waitlist;
CREATE TRIGGER trg_waitlist_position
  BEFORE INSERT ON expertise_waitlist
  FOR EACH ROW
  EXECUTE FUNCTION set_waitlist_position();

-- ============================================================================
-- 5. EXPERTISE CHANGE AUDIT LOG
-- ============================================================================
-- Prevents gaming by tracking all skill selection changes.

CREATE TABLE IF NOT EXISTS expertise_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(40) NOT NULL,
  expertise_id UUID NOT NULL REFERENCES expertise_registry(id),
  old_weight NUMERIC(3,2),
  new_weight NUMERIC(3,2),
  reason VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expertise_change_user ON expertise_change_log(user_id, created_at DESC);

-- ============================================================================
-- 6. VALIDATION
-- ============================================================================
-- SELECT
--   (SELECT COUNT(*) FROM expertise_registry WHERE active = TRUE) as expertise_count,
--   (SELECT COUNT(*) FROM expertise_capacity) as capacity_records,
--   (SELECT COUNT(*) FROM user_expertise) as user_expertise_count,
--   (SELECT COUNT(*) FROM expertise_waitlist) as waitlist_count;
