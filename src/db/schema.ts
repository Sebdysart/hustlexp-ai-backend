import { sql, isDatabaseAvailable } from './index.js';
import { logger } from '../utils/logger.js';

/**
 * Database schema statements - each must be run individually for Neon serverless
 */
const SCHEMA_STATEMENTS = [
  // Users table
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'client',
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

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hustler_profiles_active ON hustler_profiles(is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quests_user ON quests(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_events_created ON ai_events(created_at)`,
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
