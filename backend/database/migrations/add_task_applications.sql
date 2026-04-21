-- ============================================================
-- Migration: Task Applications Table
--
-- Supports the task application flow where hustlers apply for
-- tasks and posters choose which hustler to assign.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    hustler_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'counter_rejected', 'withdrawn', 'expired')),
    counter_offer_round INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active application per hustler per task
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_app_active_per_hustler
    ON task_applications(task_id, hustler_id)
    WHERE status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired');

-- Fast lookup of applications for a task
CREATE INDEX IF NOT EXISTS idx_task_applications_task_id
    ON task_applications(task_id, status);

-- Fast lookup of a hustler's applications
CREATE INDEX IF NOT EXISTS idx_task_applications_hustler_id
    ON task_applications(hustler_id, status);

-- ============================================================
-- DONE
-- ============================================================
