-- ============================================================================
-- AUDIT FIX: Missing Indexes (Performance + Correctness)
-- ============================================================================
-- From comprehensive audit 2026-02-13
-- Adds composite indexes for trigger performance and missing FK indexes
-- ============================================================================

-- Composite index for INV-3 trigger (proof acceptance check)
CREATE INDEX IF NOT EXISTS idx_proofs_task_state ON proofs(task_id, state);

-- Composite index for INV-2 / LIVE-1 trigger (escrow state check)
CREATE INDEX IF NOT EXISTS idx_escrows_task_state ON escrows(task_id, state);

-- Missing FK indexes for squad tables
CREATE INDEX IF NOT EXISTS idx_squad_task_assignments_task ON squad_task_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_squad_task_workers_worker ON squad_task_workers(worker_id);

-- Missing FK index for dispute evidence
CREATE INDEX IF NOT EXISTS idx_dispute_evidence_uploaded_by ON dispute_evidence(uploaded_by);

-- Revenue ledger indexes (idempotent versions of profitability_fixes)
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_type ON revenue_ledger(event_type);
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_user ON revenue_ledger(user_id);
