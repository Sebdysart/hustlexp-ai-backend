-- ================================
-- EXTENSIONS
-- ================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ================================
-- USERS
-- ================================
-- ================================
-- USERS
-- ================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  firebase_uid TEXT UNIQUE NOT NULL,        -- <-- IMPORTANT: links Firebase Auth → HustleXP user
  username TEXT UNIQUE,                     -- Made nullable or handling logic in code
  email TEXT UNIQUE NOT NULL,
  name TEXT,                                -- Added to match code
  role TEXT NOT NULL DEFAULT 'poster',      -- Added to match code

  zip_code TEXT,

  city TEXT,
  avatar_url TEXT,
  bio TEXT,

  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  streak INTEGER NOT NULL DEFAULT 0,
  badges TEXT[] DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW(),

  stripe_account_id TEXT,
  email_verified BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);

-- ================================
-- IDENTITY SERVICE TABLES
-- ================================
CREATE TABLE users_identity (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    phone TEXT,
    email_verified BOOLEAN DEFAULT FALSE,
    phone_verified BOOLEAN DEFAULT FALSE,
    email_verified_at TIMESTAMPTZ,
    phone_verified_at TIMESTAMPTZ,
    status TEXT DEFAULT 'unverified',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE verification_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, -- 'email' or 'sms'
    target TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    success BOOLEAN DEFAULT FALSE,
    attempt_count INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    ip_address TEXT,
    provider_sid TEXT,
    is_voip BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE identity_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    channel TEXT,
    metadata JSONB,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ================================
-- TASKS
-- ================================
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  created_by UUID NOT NULL REFERENCES users(id),

  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'delivery','moving','cleaning','yardwork','tech','creative','errands','other'
  )),

  xp_reward INTEGER NOT NULL CHECK (xp_reward > 0),
  price DECIMAL(10,2) NOT NULL CHECK (price >= 0),

  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active','assigned','in_progress','pending_review','completed','cancelled','expired'
  )),

  city TEXT NOT NULL,

  latitude DECIMAL(10,8),
  longitude DECIMAL(11,8),
  address TEXT,

  deadline TIMESTAMPTZ,
  estimated_duration TEXT,
  difficulty TEXT CHECK (difficulty IN ('easy','medium','hard')),
  image_urls TEXT[] DEFAULT '{}',

  assigned_to UUID REFERENCES users(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_category ON tasks(category);
CREATE INDEX idx_tasks_city ON tasks(city);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX idx_tasks_created_by ON tasks(created_by);
CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to);


-- ================================
-- TASK ASSIGNMENTS
-- ================================
CREATE TABLE task_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),

  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN (
    'accepted','in_progress','submitted','approved','rejected'
  )),

  proof_photos TEXT[] DEFAULT '{}',
  before_photos TEXT[] DEFAULT '{}',
  after_photos TEXT[] DEFAULT '{}',

  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  feedback TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(task_id, user_id)
);

CREATE INDEX idx_task_assignments_user ON task_assignments(user_id);
CREATE INDEX idx_task_assignments_task ON task_assignments(task_id);


-- ================================
-- TRANSACTIONS
-- ================================
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'task_escrow','task_payout','platform_fee','refund','bonus','withdrawal'
  )),

  amount DECIMAL(10,2) NOT NULL,
  task_id UUID REFERENCES tasks(id),

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','processing','completed','failed','refunded'
  )),

  stripe_payment_intent_id TEXT,
  stripe_transfer_id TEXT,
  description TEXT NOT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_task ON transactions(task_id);
CREATE INDEX idx_transactions_status ON transactions(status);


-- ================================
-- MESSAGES
-- ================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),

  content TEXT NOT NULL,
  image_url TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX idx_messages_task ON messages(task_id);
CREATE INDEX idx_messages_sender ON messages(sender_id);


-- ================================
-- USER STATS
-- ================================
CREATE TABLE user_stats (
  user_id UUID PRIMARY KEY REFERENCES users(id),

  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_posted INTEGER NOT NULL DEFAULT 0,

  total_earned DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_spent DECIMAL(10,2) NOT NULL DEFAULT 0,

  avg_rating DECIMAL(3,2) CHECK (avg_rating >= 0 AND avg_rating <= 5),
  reviews_received INTEGER NOT NULL DEFAULT 0,

  success_rate DECIMAL(5,2) CHECK (success_rate >= 0 AND success_rate <= 100),
  response_time_minutes INTEGER DEFAULT 0,

  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ================================
-- USER BOOSTS
-- ================================
CREATE TABLE user_boosts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),

  boost_id TEXT NOT NULL,

  activated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,

  uses_remaining INTEGER
);

CREATE INDEX idx_user_boosts_user ON user_boosts(user_id);


-- ================================
-- LEADERBOARD CACHE
-- ================================
CREATE TABLE leaderboard_cache (
  user_id UUID PRIMARY KEY REFERENCES users(id),

  username TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,

  weekly_xp INTEGER NOT NULL DEFAULT 0,
  all_time_xp INTEGER NOT NULL DEFAULT 0,

  level INTEGER NOT NULL DEFAULT 1,
  weekly_rank INTEGER,
  all_time_rank INTEGER,

  tasks_completed INTEGER NOT NULL DEFAULT 0,

  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_leaderboard_weekly_rank ON leaderboard_cache(weekly_rank);
CREATE INDEX idx_leaderboard_alltime_rank ON leaderboard_cache(all_time_rank);


-- ================================
-- PROACTIVE AI PREFERENCES
-- ================================
CREATE TABLE proactive_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  preferred_categories TEXT[] DEFAULT '{}',

  min_budget DECIMAL(10,2) DEFAULT 0,
  max_distance_miles INTEGER DEFAULT 10,

  availability_schedule JSONB DEFAULT '{}'::jsonb,
  notification_frequency TEXT DEFAULT 'real-time' CHECK (notification_frequency IN (
    'real-time','hourly','daily','off'
  )),

  quiet_hours_start TIME,
  quiet_hours_end TIME,

  auto_accept_enabled BOOLEAN DEFAULT FALSE,
  auto_accept_min_score DECIMAL(3,2) CHECK (auto_accept_min_score >= 0 AND auto_accept_min_score <= 1),
  auto_accept_max_per_day INTEGER DEFAULT 2 CHECK (auto_accept_max_per_day > 0),

  device_tokens TEXT[] DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_proactive_enabled ON proactive_preferences(enabled);


-- ================================
-- UPDATE TRIGGERS
-- ================================
CREATE OR REPLACE FUNCTION update_timestamp() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_tasks_timestamp
BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_proactive_timestamp
BEFORE UPDATE ON proactive_preferences
FOR EACH ROW EXECUTE FUNCTION update_timestamp();
