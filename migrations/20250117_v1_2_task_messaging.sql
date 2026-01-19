-- ============================================================================
-- V1.2 Task Messaging Tables Migration
-- Authority: Phase V1.2 — Minimal Task-Scoped Messaging (LOCKED)
-- ============================================================================
-- 
-- Purpose: Enable task-scoped messaging between poster and assigned hustler.
-- 
-- Constraints:
-- - One conversation per task (UNIQUE(task_id))
-- - Conversation opens when task enters ACCEPTED state
-- - Only poster and assigned hustler can participate
-- - Plain text messages only (no attachments, reactions, read receipts)
-- 
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Task Conversations Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  poster_id UUID NOT NULL REFERENCES users(id),
  hustler_id UUID NOT NULL REFERENCES users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- One conversation per task
  UNIQUE(task_id)
);

-- ============================================================================
-- 2. Task Messages Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES task_conversations(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('POSTER', 'HUSTLER', 'SYSTEM')),
  sender_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- 3. Indexes for Performance
-- ============================================================================

-- Conversation lookup by task
CREATE INDEX IF NOT EXISTS idx_task_conversations_task_id ON task_conversations(task_id);

-- Conversation lookup by user (for listing user's conversations)
CREATE INDEX IF NOT EXISTS idx_task_conversations_poster_id ON task_conversations(poster_id);
CREATE INDEX IF NOT EXISTS idx_task_conversations_hustler_id ON task_conversations(hustler_id);

-- Message query by conversation (for ordering messages by created_at)
CREATE INDEX IF NOT EXISTS idx_task_messages_conversation_created ON task_messages(conversation_id, created_at);

-- ============================================================================
-- 4. Comments for Documentation
-- ============================================================================

COMMENT ON TABLE task_conversations IS 'One conversation per task, opened when task enters ACCEPTED state';
COMMENT ON TABLE task_messages IS 'Plain text messages in task conversations. No attachments, reactions, or read receipts.';
COMMENT ON COLUMN task_conversations.closed_at IS 'Set when task enters COMPLETED/CANCELLED/EXPIRED state';
COMMENT ON COLUMN task_messages.sender_role IS 'POSTER, HUSTLER, or SYSTEM (for system messages)';

COMMIT;
