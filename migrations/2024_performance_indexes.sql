-- ============================================================================
-- HustleXP Performance Indexes Migration
-- Optimizes query performance for scale
-- ============================================================================

-- Enable query statistics extension for monitoring
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- ============================================================================
-- Task Feed Indexes
-- ============================================================================

-- Primary task feed query (status + created_at for listing open tasks)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_status_created 
ON tasks(status, created_at DESC) 
WHERE status IN ('open', 'in_progress');

-- Task feed with location (for geo-based feeds)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_status_location 
ON tasks(status, location_lat, location_lng, created_at DESC)
WHERE status = 'open' AND location_lat IS NOT NULL;

-- Task feed with category filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_status_category 
ON tasks(status, category_id, created_at DESC)
WHERE status = 'open';

-- ============================================================================
-- User-Related Indexes
-- ============================================================================

-- User task history (poster perspective)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_poster_status 
ON tasks(poster_id, status, created_at DESC);

-- User task history (worker perspective)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_worker_status 
ON tasks(worker_id, status, created_at DESC)
WHERE worker_id IS NOT NULL;

-- User profile lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_firebase_uid 
ON users(firebase_uid)
WHERE firebase_uid IS NOT NULL;

-- User email lookups (for admin/verification)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email 
ON users(email)
WHERE email IS NOT NULL;

-- ============================================================================
-- Application/Worker Indexes
-- ============================================================================

-- Worker applications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_applications_worker 
ON applications(worker_id, created_at DESC);

-- Task applications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_applications_task 
ON applications(task_id, status, created_at DESC);

-- Pending applications for task owner
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_applications_task_pending 
ON applications(task_id, status)
WHERE status = 'pending';

-- ============================================================================
-- Notification Indexes
-- ============================================================================

-- User notifications (unread first)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_unread 
ON notifications(user_id, created_at DESC) 
WHERE read_at IS NULL;

-- All user notifications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user 
ON notifications(user_id, created_at DESC);

-- Notification type filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_type 
ON notifications(user_id, type, created_at DESC);

-- ============================================================================
-- Message Indexes
-- ============================================================================

-- Task messages
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_task 
ON messages(task_id, created_at DESC);

-- User messages (inbox)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_receiver 
ON messages(receiver_id, created_at DESC)
WHERE receiver_id IS NOT NULL;

-- Conversation lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation 
ON messages(
  LEAST(sender_id, receiver_id), 
  GREATEST(sender_id, receiver_id), 
  created_at DESC
);

-- ============================================================================
-- Leaderboard/Stats Indexes
-- ============================================================================

-- Weekly leaderboard
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_weekly 
ON user_stats(weekly_xp DESC, id) 
WHERE weekly_xp > 0;

-- All-time leaderboard
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_alltime 
ON user_stats(total_xp DESC, id) 
WHERE total_xp > 0;

-- User stats lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_user 
ON user_stats(user_id);

-- ============================================================================
-- Payment/Transaction Indexes
-- ============================================================================

-- User transactions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user 
ON transactions(user_id, created_at DESC);

-- Transaction status
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_status 
ON transactions(status, created_at DESC)
WHERE status IN ('pending', 'processing');

-- Stripe payment intent lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_stripe 
ON transactions(stripe_payment_intent_id)
WHERE stripe_payment_intent_id IS NOT NULL;

-- Escrow lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_escrow_task 
ON escrow(task_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_escrow_status 
ON escrow(status, created_at DESC)
WHERE status IN ('holding', 'pending_release');

-- ============================================================================
-- Review Indexes
-- ============================================================================

-- Task reviews
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_task 
ON reviews(task_id);

-- User reviews (received)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_receiver 
ON reviews(receiver_id, created_at DESC);

-- User reviews (given)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_author 
ON reviews(author_id, created_at DESC);

-- ============================================================================
-- Dispute Indexes
-- ============================================================================

-- Task disputes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disputes_task 
ON disputes(task_id);

-- Open disputes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disputes_status 
ON disputes(status, created_at DESC)
WHERE status IN ('open', 'under_review');

-- User disputes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disputes_poster 
ON disputes(poster_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disputes_worker 
ON disputes(worker_id, created_at DESC);

-- ============================================================================
-- Verification Indexes
-- ============================================================================

-- User verification status
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_verifications_user 
ON verifications(user_id, created_at DESC);

-- Pending verifications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_verifications_pending 
ON verifications(status, created_at DESC)
WHERE status = 'pending';

-- ============================================================================
-- Session Indexes
-- ============================================================================

-- Active sessions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_user 
ON sessions(user_id, created_at DESC);

-- Session token lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_token 
ON sessions(token);

-- Expired session cleanup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_expires 
ON sessions(expires_at)
WHERE expires_at < NOW();

-- ============================================================================
-- Audit Log Indexes
-- ============================================================================

-- User audit log
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_user 
ON audit_logs(user_id, created_at DESC);

-- Entity audit log
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_entity 
ON audit_logs(entity_type, entity_id, created_at DESC);

-- Action type filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_action 
ON audit_logs(action, created_at DESC);

-- ============================================================================
-- Composite Indexes for Common Query Patterns
-- ============================================================================

-- Task search (status + location + category)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_search 
ON tasks(status, category_id, location_lat, location_lng, created_at DESC)
WHERE status = 'open';

-- User activity feed
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_activity 
ON user_activities(user_id, created_at DESC);

-- Activity by type
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_activity_type 
ON user_activities(user_id, activity_type, created_at DESC);

-- ============================================================================
-- Partial Indexes for Hot Data
-- ============================================================================

-- Active tasks only (excludes completed/cancelled)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_active 
ON tasks(status, created_at DESC)
WHERE status NOT IN ('completed', 'cancelled', 'expired');

-- High-value tasks (for premium features)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_high_value 
ON tasks(budget_cents DESC, created_at DESC)
WHERE budget_cents >= 10000; -- $100+

-- Recently active users
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_recent 
ON users(last_active_at DESC)
WHERE last_active_at > NOW() - INTERVAL '30 days';

-- ============================================================================
-- Index Maintenance
-- ============================================================================

-- Update statistics for query planner
ANALYZE users;
ANALYZE tasks;
ANALYZE applications;
ANALYZE messages;
ANALYZE notifications;
ANALYZE transactions;
ANALYZE reviews;

-- Log index creation
INSERT INTO schema_migrations_log (migration_name, applied_at)
VALUES ('2024_performance_indexes', NOW());
