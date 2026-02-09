-- =============================================================================
-- Migration: Worker Skills System (Gap 1)
-- 100+ skill categories with hard/soft gates, skill-based task matching
-- =============================================================================

-- Skill categories (top-level groupings)
CREATE TABLE IF NOT EXISTS skill_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  icon_name TEXT, -- for UI icon mapping
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Individual skills (100+ entries)
CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES skill_categories(id),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  icon_name TEXT,
  -- Gating
  gate_type TEXT NOT NULL DEFAULT 'soft' CHECK (gate_type IN ('soft', 'hard')),
  -- soft = unlocked by trust tier / XP
  -- hard = requires verified license/certification
  min_trust_tier INTEGER NOT NULL DEFAULT 1, -- 1=ROOKIE can do it
  requires_license BOOLEAN NOT NULL DEFAULT FALSE,
  requires_background_check BOOLEAN NOT NULL DEFAULT FALSE,
  risk_level TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')),
  -- Metadata
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Worker skill selections (many-to-many)
CREATE TABLE IF NOT EXISTS worker_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES skills(id),
  -- Verification status for hard-gated skills
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  license_url TEXT, -- uploaded license/cert photo
  license_expiry DATE,
  -- Stats
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  avg_rating NUMERIC(3,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, skill_id)
);

-- Task required skills (link tasks to skills)
CREATE TABLE IF NOT EXISTS task_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES skills(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, skill_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_worker_skills_user ON worker_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_worker_skills_skill ON worker_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_worker_skills_verified ON worker_skills(user_id, verified) WHERE verified = TRUE;
CREATE INDEX IF NOT EXISTS idx_task_skills_task ON task_skills(task_id);
CREATE INDEX IF NOT EXISTS idx_task_skills_skill ON task_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category_id);
CREATE INDEX IF NOT EXISTS idx_skills_gate ON skills(gate_type, min_trust_tier);

-- =============================================================================
-- Seed: Skill Categories (10 top-level)
-- =============================================================================
INSERT INTO skill_categories (name, display_name, icon_name, sort_order) VALUES
  ('delivery', 'Delivery & Errands', 'truck', 1),
  ('moving', 'Moving & Lifting', 'box', 2),
  ('cleaning', 'Cleaning', 'sparkles', 3),
  ('yard_work', 'Yard & Outdoor', 'leaf', 4),
  ('handyman', 'Home Maintenance', 'wrench', 5),
  ('assembly', 'Assembly & Setup', 'cog', 6),
  ('personal', 'Personal Assistance', 'user', 7),
  ('pet_care', 'Pet Care', 'paw', 8),
  ('tech', 'Tech Help', 'monitor', 9),
  ('trades', 'Licensed Trades', 'hard-hat', 10),
  ('care', 'Care & Sitting', 'heart', 11),
  ('events', 'Events & Venues', 'calendar', 12),
  ('automotive', 'Automotive', 'car', 13),
  ('misc', 'Miscellaneous', 'grid', 14)
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- Seed: Skills (100+ entries across categories)
-- =============================================================================

-- Delivery & Errands (Level 0 - Public Space)
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'grocery_pickup', 'Grocery Pickup', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'grocery_delivery', 'Grocery Delivery', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'food_delivery', 'Food Delivery', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'package_pickup', 'Package Pickup', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'prescription_pickup', 'Prescription Pickup', 'soft', 1, 'LOW', 5),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'dry_cleaning', 'Dry Cleaning Pickup/Drop', 'soft', 1, 'LOW', 6),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'waiting_in_line', 'Waiting in Line', 'soft', 1, 'LOW', 7),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'returns_exchange', 'Returns & Exchanges', 'soft', 1, 'LOW', 8),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'shopping_personal', 'Personal Shopping', 'soft', 1, 'LOW', 9),
  ((SELECT id FROM skill_categories WHERE name='delivery'), 'mail_shipping', 'Mail & Shipping', 'soft', 1, 'LOW', 10)
ON CONFLICT (name) DO NOTHING;

-- Moving & Lifting
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='moving'), 'furniture_moving', 'Furniture Moving', 'soft', 2, 'MEDIUM', 1),
  ((SELECT id FROM skill_categories WHERE name='moving'), 'heavy_lifting', 'Heavy Lifting', 'soft', 2, 'MEDIUM', 2),
  ((SELECT id FROM skill_categories WHERE name='moving'), 'loading_unloading', 'Loading/Unloading', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name='moving'), 'packing', 'Packing & Unpacking', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='moving'), 'junk_removal', 'Junk Removal', 'soft', 2, 'MEDIUM', 5),
  ((SELECT id FROM skill_categories WHERE name='moving'), 'donation_dropoff', 'Donation Drop-off', 'soft', 1, 'LOW', 6),
  ((SELECT id FROM skill_categories WHERE name='moving'), 'storage_organization', 'Storage Organization', 'soft', 1, 'MEDIUM', 7),
  ((SELECT id FROM skill_categories WHERE name='moving'), 'appliance_moving', 'Appliance Moving', 'soft', 2, 'MEDIUM', 8)
ON CONFLICT (name) DO NOTHING;

-- Cleaning
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='cleaning'), 'house_cleaning', 'House Cleaning', 'soft', 2, 'IN_HOME', 1),
  ((SELECT id FROM skill_categories WHERE name='cleaning'), 'deep_cleaning', 'Deep Cleaning', 'soft', 2, 'IN_HOME', 2),
  ((SELECT id FROM skill_categories WHERE name='cleaning'), 'garage_cleanup', 'Garage Cleanup', 'soft', 2, 'MEDIUM', 3),
  ((SELECT id FROM skill_categories WHERE name='cleaning'), 'post_event_cleanup', 'Post-Event Cleanup', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='cleaning'), 'car_cleaning', 'Car Cleaning', 'soft', 1, 'LOW', 5),
  ((SELECT id FROM skill_categories WHERE name='cleaning'), 'window_cleaning', 'Window Cleaning', 'soft', 2, 'MEDIUM', 6),
  ((SELECT id FROM skill_categories WHERE name='cleaning'), 'carpet_cleaning', 'Carpet Cleaning', 'soft', 2, 'IN_HOME', 7),
  ((SELECT id FROM skill_categories WHERE name='cleaning'), 'pressure_washing', 'Pressure Washing', 'soft', 2, 'MEDIUM', 8)
ON CONFLICT (name) DO NOTHING;

-- Yard & Outdoor
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'lawn_mowing', 'Lawn Mowing', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'leaf_raking', 'Leaf Raking', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'snow_shoveling', 'Snow Shoveling', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'garden_weeding', 'Garden Weeding', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'hedge_trimming', 'Hedge Trimming', 'soft', 1, 'MEDIUM', 5),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'gutter_cleaning', 'Gutter Cleaning', 'soft', 2, 'MEDIUM', 6),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'tree_trimming', 'Tree Trimming', 'soft', 2, 'HIGH', 7),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'mulching', 'Mulching', 'soft', 1, 'LOW', 8),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'sprinkler_setup', 'Sprinkler Setup', 'soft', 2, 'MEDIUM', 9),
  ((SELECT id FROM skill_categories WHERE name='yard_work'), 'fence_repair', 'Fence Repair', 'soft', 2, 'MEDIUM', 10)
ON CONFLICT (name) DO NOTHING;

-- Home Maintenance (soft-gated, requires higher trust)
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'hanging_art', 'Hanging Art/Shelves', 'soft', 2, 'IN_HOME', 1),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'tv_mounting', 'TV Mounting', 'soft', 2, 'IN_HOME', 2),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'painting_interior', 'Interior Painting', 'soft', 2, 'IN_HOME', 3),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'painting_exterior', 'Exterior Painting', 'soft', 2, 'MEDIUM', 4),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'drywall_patch', 'Drywall Patching', 'soft', 2, 'IN_HOME', 5),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'door_repair', 'Door Repair', 'soft', 2, 'IN_HOME', 6),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'caulking', 'Caulking & Sealing', 'soft', 2, 'IN_HOME', 7),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'light_fixture', 'Light Fixture Install', 'soft', 2, 'IN_HOME', 8),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'faucet_repair', 'Faucet Repair (Basic)', 'soft', 2, 'IN_HOME', 9),
  ((SELECT id FROM skill_categories WHERE name='handyman'), 'toilet_repair', 'Toilet Repair (Basic)', 'soft', 2, 'IN_HOME', 10)
ON CONFLICT (name) DO NOTHING;

-- Assembly & Setup
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='assembly'), 'furniture_assembly', 'Furniture Assembly', 'soft', 1, 'MEDIUM', 1),
  ((SELECT id FROM skill_categories WHERE name='assembly'), 'ikea_assembly', 'IKEA Assembly', 'soft', 1, 'MEDIUM', 2),
  ((SELECT id FROM skill_categories WHERE name='assembly'), 'shelf_install', 'Shelf Installation', 'soft', 2, 'IN_HOME', 3),
  ((SELECT id FROM skill_categories WHERE name='assembly'), 'desk_setup', 'Desk/Office Setup', 'soft', 1, 'MEDIUM', 4),
  ((SELECT id FROM skill_categories WHERE name='assembly'), 'gym_equipment', 'Gym Equipment Assembly', 'soft', 2, 'MEDIUM', 5),
  ((SELECT id FROM skill_categories WHERE name='assembly'), 'trampoline', 'Trampoline/Playset', 'soft', 2, 'MEDIUM', 6),
  ((SELECT id FROM skill_categories WHERE name='assembly'), 'grill_assembly', 'Grill Assembly', 'soft', 1, 'MEDIUM', 7),
  ((SELECT id FROM skill_categories WHERE name='assembly'), 'baby_furniture', 'Baby Furniture Assembly', 'soft', 2, 'MEDIUM', 8)
ON CONFLICT (name) DO NOTHING;

-- Personal Assistance
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='personal'), 'event_help', 'Event Setup/Cleanup', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name='personal'), 'party_assistant', 'Party Assistant', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name='personal'), 'photography', 'Photography', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name='personal'), 'gift_wrapping', 'Gift Wrapping', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='personal'), 'holiday_decorating', 'Holiday Decorating', 'soft', 1, 'MEDIUM', 5),
  ((SELECT id FROM skill_categories WHERE name='personal'), 'organizing', 'Home Organizing', 'soft', 2, 'IN_HOME', 6),
  ((SELECT id FROM skill_categories WHERE name='personal'), 'closet_organization', 'Closet Organization', 'soft', 2, 'IN_HOME', 7),
  ((SELECT id FROM skill_categories WHERE name='personal'), 'meal_prep', 'Meal Prep', 'soft', 2, 'IN_HOME', 8)
ON CONFLICT (name) DO NOTHING;

-- Pet Care
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='pet_care'), 'dog_walking', 'Dog Walking', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name='pet_care'), 'pet_sitting', 'Pet Sitting', 'soft', 2, 'IN_HOME', 2),
  ((SELECT id FROM skill_categories WHERE name='pet_care'), 'pet_feeding', 'Pet Feeding', 'soft', 2, 'IN_HOME', 3),
  ((SELECT id FROM skill_categories WHERE name='pet_care'), 'pet_grooming', 'Pet Grooming (Basic)', 'soft', 2, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='pet_care'), 'pet_transport', 'Pet Transport (Vet)', 'soft', 2, 'LOW', 5)
ON CONFLICT (name) DO NOTHING;

-- Tech Help
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='tech'), 'wifi_setup', 'WiFi/Router Setup', 'soft', 2, 'IN_HOME', 1),
  ((SELECT id FROM skill_categories WHERE name='tech'), 'smart_home', 'Smart Home Setup', 'soft', 2, 'IN_HOME', 2),
  ((SELECT id FROM skill_categories WHERE name='tech'), 'computer_setup', 'Computer/Printer Setup', 'soft', 2, 'IN_HOME', 3),
  ((SELECT id FROM skill_categories WHERE name='tech'), 'tv_setup', 'TV/Streaming Setup', 'soft', 2, 'IN_HOME', 4),
  ((SELECT id FROM skill_categories WHERE name='tech'), 'phone_help', 'Phone/Tablet Help', 'soft', 1, 'LOW', 5),
  ((SELECT id FROM skill_categories WHERE name='tech'), 'security_camera', 'Security Camera Install', 'soft', 2, 'IN_HOME', 6)
ON CONFLICT (name) DO NOTHING;

-- Licensed Trades (HARD GATED - requires license verification)
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, requires_license, requires_background_check, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='trades'), 'electrician', 'Electrician', 'hard', 3, TRUE, TRUE, 'HIGH', 1),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'plumber', 'Plumber', 'hard', 3, TRUE, TRUE, 'HIGH', 2),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'hvac', 'HVAC Technician', 'hard', 3, TRUE, TRUE, 'HIGH', 3),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'locksmith', 'Locksmith', 'hard', 3, TRUE, TRUE, 'HIGH', 4),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'carpenter', 'Carpenter', 'hard', 3, TRUE, FALSE, 'MEDIUM', 5),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'painter_pro', 'Professional Painter', 'hard', 3, TRUE, FALSE, 'MEDIUM', 6),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'welder', 'Welder', 'hard', 3, TRUE, TRUE, 'HIGH', 7),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'roofer', 'Roofer', 'hard', 3, TRUE, TRUE, 'HIGH', 8),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'tiler', 'Tiler', 'hard', 3, TRUE, FALSE, 'MEDIUM', 9),
  ((SELECT id FROM skill_categories WHERE name='trades'), 'landscaper_pro', 'Professional Landscaper', 'hard', 3, TRUE, FALSE, 'MEDIUM', 10)
ON CONFLICT (name) DO NOTHING;

-- Care & Sitting (HARD GATED - background check required)
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, requires_license, requires_background_check, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='care'), 'babysitter', 'Babysitter', 'hard', 3, FALSE, TRUE, 'IN_HOME', 1),
  ((SELECT id FROM skill_categories WHERE name='care'), 'elder_care', 'Elder Care', 'hard', 3, FALSE, TRUE, 'IN_HOME', 2),
  ((SELECT id FROM skill_categories WHERE name='care'), 'special_needs', 'Special Needs Care', 'hard', 3, TRUE, TRUE, 'IN_HOME', 3),
  ((SELECT id FROM skill_categories WHERE name='care'), 'tutoring', 'Tutoring', 'soft', 2, FALSE, FALSE, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='care'), 'companion', 'Companion/Errand Helper', 'soft', 2, FALSE, FALSE, 'LOW', 5)
ON CONFLICT (name) DO NOTHING;

-- Automotive
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='automotive'), 'car_jumpstart', 'Car Jumpstart', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name='automotive'), 'tire_change', 'Tire Change', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name='automotive'), 'car_detailing', 'Car Detailing', 'soft', 2, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name='automotive'), 'car_wash', 'Car Wash', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='automotive'), 'oil_change', 'Oil Change', 'soft', 2, 'MEDIUM', 5)
ON CONFLICT (name) DO NOTHING;

-- Events & Venues
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='events'), 'event_setup', 'Event Setup', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name='events'), 'event_breakdown', 'Event Breakdown', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name='events'), 'catering_help', 'Catering Helper', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name='events'), 'bartending', 'Bartending', 'soft', 2, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='events'), 'dj_assistant', 'DJ/Sound Assistant', 'soft', 1, 'LOW', 5)
ON CONFLICT (name) DO NOTHING;

-- Misc
INSERT INTO skills (category_id, name, display_name, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name='misc'), 'flyer_distribution', 'Flyer Distribution', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name='misc'), 'sign_holding', 'Sign Holding', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name='misc'), 'line_standing', 'Standing in Line', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name='misc'), 'mystery_shopping', 'Mystery Shopping', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name='misc'), 'survey_collection', 'Survey/Data Collection', 'soft', 1, 'LOW', 5),
  ((SELECT id FROM skill_categories WHERE name='misc'), 'notary', 'Notary Services', 'hard', 3, TRUE, FALSE, 'LOW', 6),
  ((SELECT id FROM skill_categories WHERE name='misc'), 'custom_task', 'Custom Task', 'soft', 1, 'LOW', 99)
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- Worker Price Modifier (Gap 7 - IC Compliance)
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS price_modifier_percent INTEGER NOT NULL DEFAULT 0
  CHECK (price_modifier_percent >= -25 AND price_modifier_percent <= 50);
-- Workers can set -25% to +50% on suggested rates
-- This is CRITICAL for Independent Contractor classification

-- =============================================================================
-- Shadow Ban System (Gap 6)
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow_score NUMERIC(4,2) NOT NULL DEFAULT 100.00
  CHECK (shadow_score >= 0 AND shadow_score <= 100);
-- 100 = perfect standing, 0 = fully shadow-banned
-- Below 50: limited to low-value tasks
-- Below 25: only see tasks from other low-shadow-score users

ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow_score_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS shadow_score_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  delta NUMERIC(5,2) NOT NULL, -- positive = improvement, negative = penalty
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('system', 'admin', 'fraud_detection', 'rating', 'dispute', 'cancellation')),
  score_before NUMERIC(4,2) NOT NULL,
  score_after NUMERIC(4,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_score_events_user ON shadow_score_events(user_id);
CREATE INDEX IF NOT EXISTS idx_users_shadow_score ON users(shadow_score) WHERE shadow_score < 50;

-- =============================================================================
-- Dynamic Pricing Fields (Gap 4)
-- =============================================================================
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS base_price_cents INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS surge_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.00
  CHECK (surge_multiplier >= 1.00 AND surge_multiplier <= 3.00);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worker_modifier_applied INTEGER NOT NULL DEFAULT 0;
-- Final price = base_price × surge_multiplier + worker_modifier

-- =============================================================================
-- Photo Metadata Validation (Gap 11)
-- =============================================================================
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS capture_source TEXT CHECK (capture_source IN ('live_camera', 'gallery', 'unknown'));
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS exif_timestamp TIMESTAMPTZ;
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS exif_gps_lat NUMERIC(10,7);
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS exif_gps_lng NUMERIC(10,7);
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS exif_device_model TEXT;
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS capture_validation_passed BOOLEAN;
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS capture_validation_failures TEXT[];

-- =============================================================================
-- Geofence Check-in/Check-out (Gap 8)
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_geofence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  user_id UUID NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('enter', 'exit', 'checkin', 'checkout')),
  location_lat NUMERIC(10,7) NOT NULL,
  location_lng NUMERIC(10,7) NOT NULL,
  distance_meters NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geofence_events_task ON task_geofence_events(task_id);

-- =============================================================================
-- Heat Map Aggregation (Gap 9)
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_heat_map_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  geohash TEXT NOT NULL, -- geohash precision 5 (~5km)
  center_lat NUMERIC(10,7) NOT NULL,
  center_lng NUMERIC(10,7) NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0,
  avg_price_cents INTEGER,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(geohash, period_start)
);

CREATE INDEX IF NOT EXISTS idx_heat_map_geohash ON task_heat_map_cache(geohash);
CREATE INDEX IF NOT EXISTS idx_heat_map_period ON task_heat_map_cache(period_start, period_end);

-- =============================================================================
-- Jury Pool Dispute Resolution (Gap 16)
-- =============================================================================
CREATE TABLE IF NOT EXISTS dispute_jury_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes(id),
  juror_id UUID NOT NULL REFERENCES users(id),
  vote TEXT NOT NULL CHECK (vote IN ('worker_complete', 'worker_incomplete', 'inconclusive')),
  confidence NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  xp_reward INTEGER NOT NULL DEFAULT 5, -- XP for participating
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(dispute_id, juror_id)
);

CREATE INDEX IF NOT EXISTS idx_jury_votes_dispute ON dispute_jury_votes(dispute_id);

-- =============================================================================
-- Tutorial Quest Tracking (Gap 13)
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_quest_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_quest_completed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_quest_score INTEGER;
