import { sql, isDatabaseAvailable } from './index.js';
import { logger } from '../utils/logger.js';

/**
 * Database schema statements - each must be run individually for Neon serverless
 */
const SCHEMA_STATEMENTS = [
  // Users table - roles: poster, hustler, admin
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firebase_uid VARCHAR(128) UNIQUE,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'poster',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Hustler profiles table
  `CREATE TABLE IF NOT EXISTS hustler_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    skills TEXT[] DEFAULT '{}',
    rating DECIMAL(3,2) DEFAULT 0,
    completed_tasks INTEGER DEFAULT 0,
    completion_rate DECIMAL(5,4) DEFAULT 0,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    streak INTEGER DEFAULT 0,
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    is_active BOOLEAN DEFAULT false,
    bio TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Tasks table
  `CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(50) NOT NULL,
    min_price DECIMAL(10,2),
    recommended_price DECIMAL(10,2) NOT NULL,
    max_price DECIMAL(10,2),
    location_text VARCHAR(500),
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    time_window_start TIMESTAMP WITH TIME ZONE,
    time_window_end TIMESTAMP WITH TIME ZONE,
    flags TEXT[] DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'draft',
    assigned_hustler_id UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // XP events table
  `CREATE TABLE IF NOT EXISTS xp_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    reason VARCHAR(255) NOT NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Quests table
  `CREATE TABLE IF NOT EXISTS quests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    goal_condition VARCHAR(255) NOT NULL,
    xp_reward INTEGER NOT NULL,
    progress INTEGER DEFAULT 0,
    target INTEGER DEFAULT 1,
    is_completed BOOLEAN DEFAULT false,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // AI events table
  `CREATE TABLE IF NOT EXISTS ai_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    intent VARCHAR(50),
    model_used VARCHAR(50) NOT NULL,
    task_type VARCHAR(50) NOT NULL,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost_estimate DECIMAL(10,6) DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    success BOOLEAN DEFAULT true,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Badges table - tracks all badge awards per user
  `CREATE TABLE IF NOT EXISTS badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    badge_id VARCHAR(100) NOT NULL,
    badge_name VARCHAR(255) NOT NULL,
    badge_tier VARCHAR(50) NOT NULL DEFAULT 'bronze',
    badge_category VARCHAR(100) NOT NULL,
    xp_awarded INTEGER DEFAULT 0,
    awarded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
  )`,

  // Completions table - task completion history
  `CREATE TABLE IF NOT EXISTS completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    hustler_id UUID REFERENCES users(id) ON DELETE CASCADE,
    client_id UUID REFERENCES users(id) ON DELETE SET NULL,
    category VARCHAR(50) NOT NULL,
    earnings DECIMAL(10,2) NOT NULL,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    xp_awarded INTEGER DEFAULT 0,
    streak_bonus INTEGER DEFAULT 0,
    proof_session_id UUID,
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Growth plans table - AI-generated growth plans
  `CREATE TABLE IF NOT EXISTS growth_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    plan_data JSONB NOT NULL,
    goals JSONB DEFAULT '[]',
    milestones JSONB DEFAULT '[]',
    earnings_target DECIMAL(10,2),
    xp_target INTEGER,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Card history table - social card generation history
  `CREATE TABLE IF NOT EXISTS card_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    card_type VARCHAR(50) NOT NULL,
    card_data JSONB NOT NULL,
    share_count INTEGER DEFAULT 0,
    platforms_shared TEXT[] DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Escrow table - holds funds between task acceptance and completion
  `CREATE TABLE IF NOT EXISTS escrow (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    poster_id UUID REFERENCES users(id) ON DELETE SET NULL,
    hustler_id UUID REFERENCES users(id) ON DELETE SET NULL,
    amount DECIMAL(10,2) NOT NULL,
    platform_fee DECIMAL(10,2) NOT NULL,
    hustler_payout DECIMAL(10,2) NOT NULL,
    payment_intent_id VARCHAR(255) NOT NULL,
    stripe_transfer_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    released_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT escrow_status_check CHECK (status IN ('pending', 'held', 'released', 'refunded', 'disputed'))
  )`,

  // Payouts table - tracks actual money transfers to hustlers
  `CREATE TABLE IF NOT EXISTS payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id UUID REFERENCES escrow(id) ON DELETE SET NULL,
    hustler_id UUID REFERENCES users(id) ON DELETE CASCADE,
    hustler_stripe_account_id VARCHAR(255) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    fee DECIMAL(10,2) DEFAULT 0,
    net_amount DECIMAL(10,2) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'standard',
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    stripe_transfer_id VARCHAR(255),
    stripe_payout_id VARCHAR(255),
    failure_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT payout_type_check CHECK (type IN ('standard', 'instant')),
    CONSTRAINT payout_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
  )`,

  // Proof photos table - stores task completion evidence
  `CREATE TABLE IF NOT EXISTS proof_photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    hustler_id UUID REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    photo_url VARCHAR(1000) NOT NULL,
    photo_type VARCHAR(50) NOT NULL,
    caption TEXT,
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    timestamp_exif TIMESTAMP WITH TIME ZONE,
    verified BOOLEAN DEFAULT false,
    verification_reason TEXT,
    xp_awarded INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT photo_type_check CHECK (photo_type IN ('before', 'during', 'after', 'result'))
  )`,

  // Moderation logs table - audit trail for all moderation actions
  `CREATE TABLE IF NOT EXISTS moderation_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    content_type VARCHAR(50) NOT NULL,
    content_id UUID,
    content_text TEXT,
    decision VARCHAR(50) NOT NULL,
    reason TEXT,
    model_used VARCHAR(50),
    confidence DECIMAL(3,2),
    reviewed_by_human BOOLEAN DEFAULT false,
    human_reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT moderation_decision_check CHECK (decision IN ('safe', 'suspicious', 'blocked', 'approved'))
  )`,

  // Streaks table - tracks user activity streaks
  `CREATE TABLE IF NOT EXISTS streaks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    last_activity_date DATE NOT NULL,
    streak_type VARCHAR(50) NOT NULL DEFAULT 'daily',
    bonus_multiplier DECIMAL(3,2) DEFAULT 1.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT streak_type_check CHECK (streak_type IN ('daily', 'weekly'))
  )`,

  // Add stripe_account_id to users table
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account_status VARCHAR(50) DEFAULT 'none'`,

  // Add suspension fields to users table
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason TEXT`,

  // Disputes table - handles poster/hustler conflicts
  `CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    poster_id UUID REFERENCES users(id) ON DELETE SET NULL,
    hustler_id UUID REFERENCES users(id) ON DELETE SET NULL,
    escrow_id UUID REFERENCES escrow(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'open',
    poster_reason TEXT NOT NULL,
    hustler_response TEXT,
    resolution_note TEXT,
    resolution_amount_hustler DECIMAL(10,2),
    resolution_amount_poster DECIMAL(10,2),
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT dispute_status_check CHECK (status IN ('open', 'under_review', 'resolved_refund', 'resolved_payout', 'resolved_split', 'closed'))
  )`,

  // User strikes table - tracks violations
  `CREATE TABLE IF NOT EXISTS user_strikes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'ai',
    severity INTEGER NOT NULL DEFAULT 1,
    related_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    related_dispute_id UUID REFERENCES disputes(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT strike_source_check CHECK (source IN ('ai', 'manual')),
    CONSTRAINT strike_severity_check CHECK (severity BETWEEN 1 AND 3)
  )`,

  // Enhanced moderation_logs with more fields
  `ALTER TABLE moderation_logs ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id) ON DELETE SET NULL`,
  `ALTER TABLE moderation_logs ADD COLUMN IF NOT EXISTS type VARCHAR(50)`,
  `ALTER TABLE moderation_logs ADD COLUMN IF NOT EXISTS severity VARCHAR(20)`,
  `ALTER TABLE moderation_logs ADD COLUMN IF NOT EXISTS label VARCHAR(100)`,
  `ALTER TABLE moderation_logs ADD COLUMN IF NOT EXISTS raw_input_snippet TEXT`,
  `ALTER TABLE moderation_logs ADD COLUMN IF NOT EXISTS ai_score DECIMAL(4,3)`,
  `ALTER TABLE moderation_logs ADD COLUMN IF NOT EXISTS action_taken VARCHAR(50)`,

  // Indexes for existing tables
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hustler_profiles_active ON hustler_profiles(is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quests_user ON quests(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_events_created ON ai_events(created_at)`,

  // Indexes for new tables
  `CREATE INDEX IF NOT EXISTS idx_badges_user ON badges(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_badges_badge_id ON badges(badge_id)`,
  `CREATE INDEX IF NOT EXISTS idx_completions_hustler ON completions(hustler_id)`,
  `CREATE INDEX IF NOT EXISTS idx_completions_task ON completions(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_completions_completed ON completions(completed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_growth_plans_user ON growth_plans(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_growth_plans_active ON growth_plans(is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_card_history_user ON card_history(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_card_history_type ON card_history(card_type)`,

  // Indexes for payment tables
  `CREATE INDEX IF NOT EXISTS idx_escrow_task ON escrow(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_escrow_status ON escrow(status)`,
  `CREATE INDEX IF NOT EXISTS idx_escrow_hustler ON escrow(hustler_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payouts_hustler ON payouts(hustler_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status)`,
  `CREATE INDEX IF NOT EXISTS idx_payouts_created ON payouts(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_proof_photos_task ON proof_photos(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_proof_photos_session ON proof_photos(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_moderation_logs_user ON moderation_logs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_moderation_logs_decision ON moderation_logs(decision)`,
  `CREATE INDEX IF NOT EXISTS idx_streaks_user ON streaks(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_streaks_user_type ON streaks(user_id, streak_type)`,

  // Indexes for disputes and strikes
  `CREATE INDEX IF NOT EXISTS idx_disputes_task ON disputes(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status)`,
  `CREATE INDEX IF NOT EXISTS idx_disputes_poster ON disputes(poster_id)`,
  `CREATE INDEX IF NOT EXISTS idx_disputes_hustler ON disputes(hustler_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_strikes_user ON user_strikes(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_strikes_severity ON user_strikes(severity)`,
  `CREATE INDEX IF NOT EXISTS idx_moderation_logs_type ON moderation_logs(type)`,
  `CREATE INDEX IF NOT EXISTS idx_moderation_logs_severity ON moderation_logs(severity)`,

  // ============================================
  // Phase D — Analytics Tables
  // ============================================

  // Unified event log - all key actions in one place
  `CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'backend',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT event_source_check CHECK (source IN ('frontend', 'backend', 'ai'))
  )`,

  // AI metrics - cost and performance per call
  `CREATE TABLE IF NOT EXISTS ai_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(100) NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd DECIMAL(10,6) NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    route_type VARCHAR(50) NOT NULL,
    success BOOLEAN NOT NULL DEFAULT true,
    error_code VARCHAR(100),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT ai_provider_check CHECK (provider IN ('openai', 'deepseek', 'groq'))
  )`,

  // Indexes for events
  `CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_source ON events(source)`,

  // Indexes for ai_metrics
  `CREATE INDEX IF NOT EXISTS idx_ai_metrics_provider ON ai_metrics(provider)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_metrics_route ON ai_metrics(route_type)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_metrics_created ON ai_metrics(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_metrics_success ON ai_metrics(success)`,

  // ============================================
  // Phase E — Multi-City & Scale Tables
  // ============================================

  // Cities table
  `CREATE TABLE IF NOT EXISTS cities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    active BOOLEAN DEFAULT true,
    default_timezone VARCHAR(50) DEFAULT 'America/Los_Angeles',
    bounds_north DECIMAL(10,6),
    bounds_south DECIMAL(10,6),
    bounds_east DECIMAL(10,6),
    bounds_west DECIMAL(10,6),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Zones table (neighborhoods within cities)
  `CREATE TABLE IF NOT EXISTS zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_id UUID REFERENCES cities(id) ON DELETE CASCADE,
    slug VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    polygon JSONB,
    bounds_north DECIMAL(10,6),
    bounds_south DECIMAL(10,6),
    bounds_east DECIMAL(10,6),
    bounds_west DECIMAL(10,6),
    is_downtown BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(city_id, slug)
  )`,

  // Marketplace rules (config per city)
  `CREATE TABLE IF NOT EXISTS marketplace_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_id UUID REFERENCES cities(id) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    value JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(city_id, key)
  )`,

  // Feature flags
  `CREATE TABLE IF NOT EXISTS feature_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    enabled_global BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Feature flag overrides (per city or user)
  `CREATE TABLE IF NOT EXISTS feature_flag_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flag_id UUID REFERENCES feature_flags(id) ON DELETE CASCADE,
    city_id UUID REFERENCES cities(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Daily metrics snapshots
  `CREATE TABLE IF NOT EXISTS daily_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    city_id UUID REFERENCES cities(id) ON DELETE CASCADE,
    tasks_created INTEGER DEFAULT 0,
    tasks_accepted INTEGER DEFAULT 0,
    tasks_completed INTEGER DEFAULT 0,
    tasks_cancelled INTEGER DEFAULT 0,
    disputes_opened INTEGER DEFAULT 0,
    disputes_resolved INTEGER DEFAULT 0,
    completion_rate DECIMAL(5,4) DEFAULT 0,
    gmv_usd DECIMAL(12,2) DEFAULT 0,
    platform_revenue_usd DECIMAL(12,2) DEFAULT 0,
    ai_cost_usd DECIMAL(10,4) DEFAULT 0,
    active_hustlers INTEGER DEFAULT 0,
    active_posters INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(date, city_id)
  )`,

  // Weekly metrics snapshots
  `CREATE TABLE IF NOT EXISTS weekly_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_start_date DATE NOT NULL,
    city_id UUID REFERENCES cities(id) ON DELETE CASCADE,
    tasks_created INTEGER DEFAULT 0,
    tasks_completed INTEGER DEFAULT 0,
    disputes_opened INTEGER DEFAULT 0,
    disputes_resolved INTEGER DEFAULT 0,
    completion_rate DECIMAL(5,4) DEFAULT 0,
    gmv_usd DECIMAL(12,2) DEFAULT 0,
    platform_revenue_usd DECIMAL(12,2) DEFAULT 0,
    ai_cost_usd DECIMAL(10,4) DEFAULT 0,
    new_users INTEGER DEFAULT 0,
    active_users INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(week_start_date, city_id)
  )`,

  // Indexes for Phase E tables
  `CREATE INDEX IF NOT EXISTS idx_cities_slug ON cities(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_cities_active ON cities(active)`,
  `CREATE INDEX IF NOT EXISTS idx_zones_city ON zones(city_id)`,
  `CREATE INDEX IF NOT EXISTS idx_zones_slug ON zones(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_marketplace_rules_city ON marketplace_rules(city_id)`,
  `CREATE INDEX IF NOT EXISTS idx_marketplace_rules_key ON marketplace_rules(key)`,
  `CREATE INDEX IF NOT EXISTS idx_feature_flags_key ON feature_flags(key)`,
  `CREATE INDEX IF NOT EXISTS idx_feature_flag_overrides_flag ON feature_flag_overrides(flag_id)`,
  `CREATE INDEX IF NOT EXISTS idx_feature_flag_overrides_city ON feature_flag_overrides(city_id)`,
  `CREATE INDEX IF NOT EXISTS idx_feature_flag_overrides_user ON feature_flag_overrides(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_metrics_city ON daily_metrics(city_id)`,
  `CREATE INDEX IF NOT EXISTS idx_weekly_metrics_date ON weekly_metrics(week_start_date)`,
  `CREATE INDEX IF NOT EXISTS idx_weekly_metrics_city ON weekly_metrics(city_id)`,

  // ============================================
  // Phase F — Admin Console & Notifications Tables
  // ============================================

  // Notifications table
  `CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(100) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'email',
    payload JSONB DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT notification_channel_check CHECK (channel IN ('email', 'push', 'sms')),
    CONSTRAINT notification_status_check CHECK (status IN ('pending', 'sent', 'failed'))
  )`,

  // Beta invites table
  `CREATE TABLE IF NOT EXISTS beta_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'hustler',
    city_id UUID REFERENCES cities(id) ON DELETE CASCADE,
    max_uses INTEGER DEFAULT 1,
    uses INTEGER DEFAULT 0,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT invite_role_check CHECK (role IN ('hustler', 'poster', 'both'))
  )`,

  // Admin actions log
  `CREATE TABLE IF NOT EXISTS admin_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action_type VARCHAR(100) NOT NULL,
    target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    target_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    target_dispute_id UUID REFERENCES disputes(id) ON DELETE SET NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Indexes for Phase F tables
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_beta_invites_code ON beta_invites(code)`,
  `CREATE INDEX IF NOT EXISTS idx_beta_invites_city ON beta_invites(city_id)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_actions_admin ON admin_actions(admin_id)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_actions_type ON admin_actions(action_type)`,
];

/**
 * Run database migrations - executes each statement individually
 */
export async function runMigrations(): Promise<void> {
  if (!isDatabaseAvailable() || !sql) {
    logger.warn('Skipping migrations - database not configured');
    return;
  }

  try {
    logger.info('Running database migrations...');

    for (const statement of SCHEMA_STATEMENTS) {
      await sql(statement);
    }

    logger.info('Database migrations completed successfully');
  } catch (error) {
    logger.error({ error }, 'Database migrations failed');
    throw error;
  }
}

/**
 * Seed initial test data
 */
export async function seedTestData(): Promise<void> {
  if (!isDatabaseAvailable() || !sql) {
    return;
  }

  try {
    // Check if we already have data
    const users = await sql`SELECT COUNT(*) as count FROM users`;
    if (Number(users[0].count) > 0) {
      logger.debug('Test data already exists, skipping seed');
      return;
    }

    logger.info('Seeding test data...');

    // Create test client
    await sql`
      INSERT INTO users (id, email, name, role)
      VALUES ('11111111-1111-1111-1111-111111111111', 'client@test.com', 'Test Client', 'client')
      ON CONFLICT (email) DO NOTHING
    `;

    // Create test hustlers
    await sql`
      INSERT INTO users (id, email, name, role)
      VALUES ('22222222-2222-2222-2222-222222222222', 'hustler1@test.com', 'Alex Hustler', 'hustler')
      ON CONFLICT (email) DO NOTHING
    `;
    await sql`
      INSERT INTO users (id, email, name, role)
      VALUES ('33333333-3333-3333-3333-333333333333', 'hustler2@test.com', 'Sam Hustler', 'hustler')
      ON CONFLICT (email) DO NOTHING
    `;
    await sql`
      INSERT INTO users (id, email, name, role)
      VALUES ('44444444-4444-4444-4444-444444444444', 'hustler3@test.com', 'Jordan Hustler', 'hustler')
      ON CONFLICT (email) DO NOTHING
    `;

    // Create hustler profiles
    await sql`
      INSERT INTO hustler_profiles (user_id, skills, rating, completed_tasks, completion_rate, xp, level, streak, latitude, longitude, is_active, bio)
      VALUES ('22222222-2222-2222-2222-222222222222', ARRAY['delivery', 'errands', 'moving'], 4.8, 47, 0.94, 2350, 8, 5, 47.6062, -122.3321, true, 'Quick and reliable, I have a truck!')
      ON CONFLICT (user_id) DO NOTHING
    `;
    await sql`
      INSERT INTO hustler_profiles (user_id, skills, rating, completed_tasks, completion_rate, xp, level, streak, latitude, longitude, is_active, bio)
      VALUES ('33333333-3333-3333-3333-333333333333', ARRAY['cleaning', 'pet_care', 'yard_work'], 4.9, 83, 0.97, 4120, 12, 14, 47.6205, -122.3493, true, 'Pet lover and cleaning expert')
      ON CONFLICT (user_id) DO NOTHING
    `;
    await sql`
      INSERT INTO hustler_profiles (user_id, skills, rating, completed_tasks, completion_rate, xp, level, streak, latitude, longitude, is_active, bio)
      VALUES ('44444444-4444-4444-4444-444444444444', ARRAY['handyman', 'tech_help', 'moving'], 4.7, 31, 0.90, 1550, 6, 2, 47.6097, -122.3331, true, 'Handy with tools and tech')
      ON CONFLICT (user_id) DO NOTHING
    `;

    logger.info('Test data seeded successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to seed test data');
  }
}
