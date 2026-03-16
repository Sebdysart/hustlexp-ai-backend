-- ============================================================================
-- Migration 006: Seed Skills Tables & Trust Tier Audit Trigger
-- ============================================================================
-- 1. Seeds skill_categories and skills tables with initial data
-- 2. Creates the trust_tier_audit trigger for the users table
--
-- All statements are idempotent (ON CONFLICT DO NOTHING, IF NOT EXISTS).
-- ============================================================================


-- ============================================================================
-- PART 1: SEED SKILL CATEGORIES
-- ============================================================================
-- Table schema: id, name (UNIQUE), display_name, icon_name, sort_order, created_at

INSERT INTO skill_categories (name, display_name, icon_name, sort_order) VALUES
  ('general_labor', 'General Labor', 'hammer', 1),
  ('delivery', 'Delivery', 'truck', 2),
  ('tech_help', 'Tech Help', 'monitor', 3),
  ('home_services', 'Home Services', 'wrench', 4),
  ('personal_services', 'Personal Services', 'user', 5),
  ('professional', 'Professional', 'briefcase', 6),
  ('creative', 'Creative', 'palette', 7)
ON CONFLICT (name) DO NOTHING;


-- ============================================================================
-- PART 2: SEED SKILLS
-- ============================================================================
-- Table schema: id, category_id, name (UNIQUE), display_name, description,
--   icon_name, gate_type, min_trust_tier, requires_license,
--   requires_background_check, risk_level, is_active, sort_order, created_at

-- General Labor
INSERT INTO skills (category_id, name, display_name, description, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name = 'general_labor'), 'moving_help', 'Moving Help', 'Help with moving furniture and boxes', 'soft', 1, 'MEDIUM', 1),
  ((SELECT id FROM skill_categories WHERE name = 'general_labor'), 'cleaning', 'Cleaning', 'General cleaning of homes or offices', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name = 'general_labor'), 'yard_work', 'Yard Work', 'Lawn mowing, raking, and garden maintenance', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name = 'general_labor'), 'furniture_assembly', 'Furniture Assembly', 'Assembling flat-pack and ready-to-assemble furniture', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name = 'general_labor'), 'heavy_lifting', 'Heavy Lifting', 'Carrying and moving heavy items', 'soft', 1, 'MEDIUM', 5)
ON CONFLICT (name) DO NOTHING;

-- Delivery
INSERT INTO skills (category_id, name, display_name, description, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name = 'delivery'), 'package_delivery', 'Package Delivery', 'Delivering packages to specified locations', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name = 'delivery'), 'grocery_delivery_seed', 'Grocery Delivery', 'Picking up and delivering groceries', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name = 'delivery'), 'food_delivery_seed', 'Food Delivery', 'Delivering prepared food from restaurants', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name = 'delivery'), 'document_courier', 'Document Courier', 'Secure delivery of important documents', 'soft', 1, 'LOW', 4)
ON CONFLICT (name) DO NOTHING;

-- Tech Help
INSERT INTO skills (category_id, name, display_name, description, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name = 'tech_help'), 'computer_setup_seed', 'Computer Setup', 'Setting up computers, printers, and peripherals', 'soft', 2, 'IN_HOME', 1),
  ((SELECT id FROM skill_categories WHERE name = 'tech_help'), 'phone_repair', 'Phone Repair', 'Basic phone screen and battery repairs', 'soft', 2, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name = 'tech_help'), 'smart_home_setup_seed', 'Smart Home Setup', 'Installing and configuring smart home devices', 'soft', 2, 'IN_HOME', 3),
  ((SELECT id FROM skill_categories WHERE name = 'tech_help'), 'wifi_troubleshooting', 'WiFi Troubleshooting', 'Diagnosing and fixing WiFi connectivity issues', 'soft', 2, 'IN_HOME', 4)
ON CONFLICT (name) DO NOTHING;

-- Home Services
INSERT INTO skills (category_id, name, display_name, description, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name = 'home_services'), 'plumbing_help', 'Plumbing Help', 'Basic plumbing repairs and fixture installation', 'soft', 2, 'IN_HOME', 1),
  ((SELECT id FROM skill_categories WHERE name = 'home_services'), 'electrical_help', 'Electrical Help', 'Basic electrical work like replacing outlets and switches', 'soft', 2, 'IN_HOME', 2),
  ((SELECT id FROM skill_categories WHERE name = 'home_services'), 'painting_seed', 'Painting', 'Interior and exterior painting services', 'soft', 2, 'IN_HOME', 3),
  ((SELECT id FROM skill_categories WHERE name = 'home_services'), 'appliance_install', 'Appliance Install', 'Installing household appliances', 'soft', 2, 'IN_HOME', 4)
ON CONFLICT (name) DO NOTHING;

-- Personal Services
INSERT INTO skills (category_id, name, display_name, description, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name = 'personal_services'), 'dog_walking_seed', 'Dog Walking', 'Walking dogs on scheduled routes', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name = 'personal_services'), 'pet_sitting_seed', 'Pet Sitting', 'Caring for pets in their home', 'soft', 2, 'IN_HOME', 2),
  ((SELECT id FROM skill_categories WHERE name = 'personal_services'), 'tutoring_seed', 'Tutoring', 'Academic tutoring for students of all ages', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name = 'personal_services'), 'personal_shopping_seed', 'Personal Shopping', 'Shopping for items on behalf of clients', 'soft', 1, 'LOW', 4),
  ((SELECT id FROM skill_categories WHERE name = 'personal_services'), 'laundry', 'Laundry', 'Washing, drying, and folding laundry', 'soft', 1, 'LOW', 5)
ON CONFLICT (name) DO NOTHING;

-- Professional
INSERT INTO skills (category_id, name, display_name, description, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name = 'professional'), 'photography_seed', 'Photography', 'Event and portrait photography services', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name = 'professional'), 'notary_seed', 'Notary', 'Notary public services for document authentication', 'hard', 3, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name = 'professional'), 'tax_prep', 'Tax Prep', 'Tax preparation and filing assistance', 'soft', 2, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name = 'professional'), 'translation', 'Translation', 'Written and verbal translation services', 'soft', 1, 'LOW', 4)
ON CONFLICT (name) DO NOTHING;

-- Creative
INSERT INTO skills (category_id, name, display_name, description, gate_type, min_trust_tier, risk_level, sort_order) VALUES
  ((SELECT id FROM skill_categories WHERE name = 'creative'), 'graphic_design', 'Graphic Design', 'Creating visual content and designs', 'soft', 1, 'LOW', 1),
  ((SELECT id FROM skill_categories WHERE name = 'creative'), 'video_editing', 'Video Editing', 'Editing and producing video content', 'soft', 1, 'LOW', 2),
  ((SELECT id FROM skill_categories WHERE name = 'creative'), 'music_performance', 'Music Performance', 'Live music performance for events', 'soft', 1, 'LOW', 3),
  ((SELECT id FROM skill_categories WHERE name = 'creative'), 'event_planning', 'Event Planning', 'Planning and coordinating events', 'soft', 1, 'LOW', 4)
ON CONFLICT (name) DO NOTHING;


-- ============================================================================
-- PART 3: TRUST TIER AUDIT TRIGGER
-- ============================================================================
-- Creates a trigger that logs tier changes to the trust_ledger table.
-- trust_ledger columns: user_id, old_tier, new_tier, reason, changed_at
-- (plus optional: reason_details, task_id, dispute_id, changed_by, etc.)

CREATE OR REPLACE FUNCTION audit_trust_tier_change() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.trust_tier IS DISTINCT FROM NEW.trust_tier THEN
    INSERT INTO trust_ledger (user_id, old_tier, new_tier, reason, changed_at)
    VALUES (NEW.id, OLD.trust_tier, NEW.trust_tier, 'tier_change', NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trust_tier_audit') THEN
    CREATE TRIGGER trust_tier_audit
      AFTER UPDATE OF trust_tier ON users
      FOR EACH ROW EXECUTE FUNCTION audit_trust_tier_change();
  END IF;
END $$;


-- ============================================================================
-- PART 4: SCHEMA VERSION TRACKING
-- ============================================================================
INSERT INTO schema_versions (version, applied_at)
VALUES ('006_seed_skills', NOW())
ON CONFLICT DO NOTHING;


-- ============================================================================
-- END OF MIGRATION 006
-- ============================================================================
