-- Align the legacy startup performance-index batch with the canonical schema.
-- xp_ledger records awards with awarded_at; it has never owned created_at.

CREATE INDEX IF NOT EXISTS idx_matching_scores_hustler_feed
  ON task_matching_scores(hustler_id, expires_at DESC, relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_matching_scores_hustler_distance
  ON task_matching_scores(hustler_id, expires_at DESC, distance_miles ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_state_category
  ON tasks(state, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_state_price
  ON tasks(state, price DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escrows_task_state
  ON escrows(task_id, state);
CREATE INDEX IF NOT EXISTS idx_task_messages_task_created
  ON task_messages(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_user_created
  ON xp_ledger(user_id, awarded_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_ratings_ratee
  ON task_ratings(ratee_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_events_unprocessed
  ON outbox_events(processed_at, created_at ASC) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_proofs_task_state
  ON proofs(task_id, state);
