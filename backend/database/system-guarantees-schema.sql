-- ============================================================================
-- SYSTEM GUARANTEES SCHEMA (v1.2.0)
-- ============================================================================
-- STATUS: CONSTITUTIONAL — DO NOT MODIFY WITHOUT VERSION BUMP
-- AUTHORITY: ARCHITECTURE §2.4 (Outbox pattern, job queues, file storage, email)
-- 
-- Purpose: Implements system guarantees (idempotency, auditability, backpressure)
-- via outbox pattern, exports state machine, and email outbox.
-- 
-- Three Invariants:
-- 1. Idempotency: Same event can be processed twice without double-charging/XP/email
-- 2. Auditability: Every side effect ties back to an immutable event
-- 3. Backpressure: Surges don't melt core API
-- ============================================================================

-- ----------------------------------------------------------------------------
-- OUTBOX PATTERN (System Guarantee: Idempotency + Auditability)
-- ----------------------------------------------------------------------------
-- Authority: ARCHITECTURE §2.4 (Outbox pattern for reliable job queue integration)
-- Purpose: Ensures domain events are persisted in same transaction, then enqueued to BullMQ
-- 
-- Pattern: API writes domain event + outbox row → worker reads outbox → enqueues BullMQ job
-- This ensures at-least-once delivery without losing events.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Event identity (for idempotency)
    event_type VARCHAR(100) NOT NULL,
    aggregate_type VARCHAR(50) NOT NULL,  -- 'task', 'escrow', 'user', 'export', 'notification'
    aggregate_id UUID NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,  -- For optimistic locking
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,  -- Format: {event_type}:{aggregate_id}:{version}
    
    -- Event payload
    payload JSONB NOT NULL,
    
    -- Queue routing
    queue_name VARCHAR(50) NOT NULL CHECK (queue_name IN (
        'critical_payments',
        'critical_trust',
        'user_notifications',
        'exports',
        'maintenance'
    )),
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'enqueued', 'processed', 'failed')),
    enqueued_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    error_message TEXT,
    attempts INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_queue ON outbox_events(queue_name, status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_idempotency ON outbox_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events(aggregate_type, aggregate_id, event_version);

-- ----------------------------------------------------------------------------
-- EXPORTS TABLE (GDPR Export State Machine)
-- ----------------------------------------------------------------------------
-- Authority: GDPR_COMPLIANCE_SPEC.md §2 (Data export pipeline)
-- Purpose: Track export generation lifecycle with immutable state transitions
-- 
-- State machine: queued → generating → ready → failed → expired
-- Hard rule: Every export must have DB row + immutable object key + checksum
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Reference
    gdpr_request_id UUID NOT NULL REFERENCES gdpr_data_requests(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Export metadata
    export_format VARCHAR(10) NOT NULL CHECK (export_format IN ('json', 'csv', 'pdf')),
    content_type VARCHAR(100) NOT NULL,  -- 'application/json', 'text/csv', 'application/pdf'
    
    -- State machine
    status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued',      -- Job enqueued, waiting for worker
        'generating',  -- Worker is generating file
        'ready',       -- File uploaded, signed URL available
        'failed',      -- Generation/upload failed
        'expired'      -- Signed URL expired (file still in R2)
    )),
    
    -- Storage (R2)
    object_key VARCHAR(500),  -- Format: exports/{user_id}/{export_id}/{yyyy-mm-dd}/{filename}
    bucket_name VARCHAR(100) NOT NULL DEFAULT 'hustlexp-exports',
    file_size_bytes BIGINT,
    sha256_checksum VARCHAR(64),  -- For integrity verification
    
    -- Signed URL (expires in 15 minutes)
    signed_url TEXT,
    signed_url_expires_at TIMESTAMPTZ,
    
    -- Lifecycle
    generated_at TIMESTAMPTZ,
    uploaded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,  -- 30 days from generation
    
    -- Error tracking
    error_message TEXT,
    generation_attempts INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exports_gdpr_request ON exports(gdpr_request_id);
CREATE INDEX IF NOT EXISTS idx_exports_user ON exports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exports_status ON exports(status, created_at) WHERE status IN ('queued', 'generating');
CREATE INDEX IF NOT EXISTS idx_exports_expires ON exports(expires_at) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_exports_url_expires ON exports(signed_url_expires_at) WHERE signed_url IS NOT NULL;

-- ----------------------------------------------------------------------------
-- EMAIL OUTBOX TABLE (Async Email Delivery)
-- ----------------------------------------------------------------------------
-- Authority: NOTIFICATION_SPEC.md §2.4 (Multi-channel delivery)
-- Purpose: Async email delivery with retries, backoff, suppression handling
-- 
-- Hard rule: Email send is never inline on request paths. Always async.
-- Pattern: Service writes to email_outbox → worker sends → updates row
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Recipient
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_email VARCHAR(255) NOT NULL,
    
    -- Template
    template VARCHAR(100) NOT NULL,  -- 'export_ready', 'task_status_changed', 'gdpr_deletion_complete', etc.
    params_json JSONB NOT NULL DEFAULT '{}',
    
    -- Email content (if no template, use direct)
    subject VARCHAR(500),
    html_body TEXT,
    text_body TEXT,
    
    -- Priority
    priority VARCHAR(10) NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    last_error TEXT,
    
    -- Provider tracking
    provider_name VARCHAR(50) DEFAULT 'sendgrid',  -- 'sendgrid' or 'ses' (future)
    provider_msg_id VARCHAR(255),  -- Provider's message ID for tracking
    
    -- Suppression handling
    suppressed_reason VARCHAR(100),  -- 'bounce', 'complaint', 'unsubscribe'
    suppressed_at TIMESTAMPTZ,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,  -- Provider webhook confirmation
    next_retry_at TIMESTAMPTZ  -- Exponential backoff
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_email_outbox_retry ON email_outbox(next_retry_at) WHERE status = 'failed' AND attempts < max_attempts;
CREATE INDEX IF NOT EXISTS idx_email_outbox_user ON email_outbox(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_outbox_template ON email_outbox(template, status);
CREATE INDEX IF NOT EXISTS idx_email_outbox_suppressed ON email_outbox(to_email, suppressed_at) WHERE status = 'suppressed';

-- ----------------------------------------------------------------------------
-- TRIGGERS
-- ----------------------------------------------------------------------------

-- Auto-update updated_at timestamps (reuse existing function if exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    CREATE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  END IF;
END $$;

CREATE TRIGGER IF NOT EXISTS exports_updated_at
  BEFORE UPDATE ON exports
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ----------------------------------------------------------------------------
-- SCHEMA VERSION UPDATE (v1.2.0)
-- ----------------------------------------------------------------------------

INSERT INTO schema_versions (version, applied_by, checksum, notes)
VALUES ('1.2.0', 'system', 'SYSTEM_GUARANTEES', 'Added outbox pattern (outbox_events), exports state machine (exports), email outbox (email_outbox) for idempotency, auditability, and backpressure')
ON CONFLICT (version) DO NOTHING;
