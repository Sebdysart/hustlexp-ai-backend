-- Migration 007: Performance Indexes
-- Adds compound indexes for the task feed query hot path
-- and missing indexes identified in the production audit.
--
-- All CREATE INDEX IF NOT EXISTS — safe to re-run.
-- CONCURRENTLY cannot be used inside a transaction, so these are normal indexes.

-- ============================================================================
-- TASK FEED (getFeed) — hot path, JOIN tasks ↔ task_matching_scores
-- ============================================================================

-- Compound index for the primary getFeed join: hustler_id + expires_at filter + relevance sort
-- Covers: WHERE tms.hustler_id = ? AND tms.expires_at > NOW() ORDER BY tms.relevance_score DESC
CREATE INDEX IF NOT EXISTS idx_matching_scores_hustler_feed
  ON task_matching_scores(hustler_id, expires_at DESC, relevance_score DESC);

-- Compound index for distance-sorted feed
CREATE INDEX IF NOT EXISTS idx_matching_scores_hustler_distance
  ON task_matching_scores(hustler_id, expires_at DESC, distance_miles ASC);

-- Compound index for tasks.state + category filter (common feed filter)
CREATE INDEX IF NOT EXISTS idx_tasks_state_category
  ON tasks(state, category, created_at DESC);

-- Compound index for tasks.state + price range (common feed filter)
CREATE INDEX IF NOT EXISTS idx_tasks_state_price
  ON tasks(state, price DESC, created_at DESC);

-- ============================================================================
-- ESCROW LOOKUPS (used by worker task detail, proof review)
-- ============================================================================

-- Escrow by task_id + state (common query: "find funded escrow for this task")
CREATE INDEX IF NOT EXISTS idx_escrows_task_state
  ON escrows(task_id, state);

-- ============================================================================
-- MESSAGING (conversation loading)
-- ============================================================================

-- Messages by task_id ordered by creation (chat scroll)
CREATE INDEX IF NOT EXISTS idx_task_messages_task_created
  ON task_messages(task_id, created_at DESC);

-- ============================================================================
-- XP LEDGER (user XP history)
-- ============================================================================

-- XP ledger by user ordered by time (XP history screen)
CREATE INDEX IF NOT EXISTS idx_xp_ledger_user_created
  ON xp_ledger(user_id, created_at DESC);

-- ============================================================================
-- TASK RATINGS (profile stats)
-- ============================================================================

-- Ratings by ratee (average rating calculation)
CREATE INDEX IF NOT EXISTS idx_task_ratings_ratee
  ON task_ratings(ratee_id);

-- ============================================================================
-- NOTIFICATIONS (notification list)
-- ============================================================================

-- Notifications by user ordered by time (notification feed)
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

-- Unread notifications count
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, is_read) WHERE is_read = false;

-- ============================================================================
-- OUTBOX EVENTS (worker polling)
-- ============================================================================

-- Outbox poller: unprocessed events ordered by creation
CREATE INDEX IF NOT EXISTS idx_outbox_events_unprocessed
  ON outbox_events(processed_at, created_at ASC) WHERE processed_at IS NULL;

-- ============================================================================
-- PROOFS (proof review lookups)
-- ============================================================================

-- Proofs by task_id + state
CREATE INDEX IF NOT EXISTS idx_proofs_task_state
  ON proofs(task_id, state);

-- Record migration
INSERT INTO schema_versions (version, description, applied_at)
VALUES ('1.7.0', 'Performance indexes for feed, messaging, notifications', NOW())
ON CONFLICT DO NOTHING;
