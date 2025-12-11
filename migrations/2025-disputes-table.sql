-- ======================================================================
-- MIGRATION: DISPUTE ENGINE V1
-- ======================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DROP TABLE IF EXISTS disputes CASCADE;

CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    task_id UUID NOT NULL REFERENCES tasks(id),

    poster_uid TEXT NOT NULL,  -- Firebase UID
    hustler_uid TEXT NOT NULL, -- Firebase UID

    status TEXT NOT NULL CHECK (status IN (
        'pending',
        'under_review',
        'refunded',
        'upheld'
    )),

    description TEXT,
    evidence_urls TEXT[] DEFAULT '{}',
    response_message TEXT,

    final_refund_amount INT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    locked_at TIMESTAMP WITH TIME ZONE
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_disputes_task ON disputes(task_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_poster ON disputes(poster_uid);
CREATE INDEX IF NOT EXISTS idx_disputes_hustler ON disputes(hustler_uid);

-- ======================================================================
-- END MIGRATION
-- ======================================================================
