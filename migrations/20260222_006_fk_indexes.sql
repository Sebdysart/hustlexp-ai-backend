-- FK and composite indexes for query performance
CREATE INDEX IF NOT EXISTS idx_task_messages_sender_id ON task_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_task_messages_receiver_id ON task_messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_disputes_poster_id ON disputes(poster_id);
CREATE INDEX IF NOT EXISTS idx_disputes_worker_id ON disputes(worker_id);
CREATE INDEX IF NOT EXISTS idx_disputes_initiated_by ON disputes(initiated_by);
CREATE INDEX IF NOT EXISTS idx_escrows_task_id ON escrows(task_id);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_user_id ON xp_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_task_id ON xp_ledger(task_id);
CREATE INDEX IF NOT EXISTS idx_trust_ledger_user_id ON trust_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fraud_risk_scores_entity ON fraud_risk_scores(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_created ON analytics_events(user_id, created_at);
-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_state_created ON tasks(state, created_at);
CREATE INDEX IF NOT EXISTS idx_users_xp_desc ON users(xp_total DESC);
