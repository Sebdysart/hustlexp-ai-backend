-- Migration 010: Business Leads Table (Roadmap E3 — Business Demand Mode)
--
-- Anonymous, demand-sensing lead capture for the /business acquisition lane.
-- Receives what the public, rate-limited business.submitLead mutation collects.
--
-- HONESTY / SCOPE INVARIANTS (do not violate without a roadmap update):
--   1. Every lead is inserted with status = 'NEW' and requires_review = true.
--      There is NO auto-approval path in E3 — review/approval is E4+.
--   2. PII minimization: only ip_hash is stored, never a raw IP address.
--   3. This table is write-only from the public mutation; it has no consumer
--      funnel coupling and no dashboard/admin surface in E3.
--
-- Additive migration (CREATE TABLE IF NOT EXISTS) — safe to apply to an
-- existing database. Do NOT apply via db:migrate (migrate-pg.mjs drops and
-- rebuilds the whole schema from constitutional-schema.sql); apply directly,
-- e.g.  psql "$DATABASE_URL" -f backend/database/migrations/010-business-leads.sql

CREATE TABLE IF NOT EXISTS business_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Business / contact identity
    business_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    business_type TEXT NOT NULL,
    city TEXT,
    zip TEXT NOT NULL,

    -- Demand signal
    recurring_task_types JSONB NOT NULL DEFAULT '[]',
    expected_frequency TEXT,
    avg_budget_cents INTEGER,
    urgency TEXT,
    notes TEXT,

    -- Risk + compliance
    risk_flags JSONB NOT NULL DEFAULT '{}',
    contact_preference TEXT NOT NULL DEFAULT 'form' CHECK (contact_preference IN ('form', 'call')),
    status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'REVIEWED', 'APPROVED', 'REJECTED', 'CONVERTED')),
    compliance_score INTEGER,
    compliance_notes JSONB,
    requires_review BOOLEAN NOT NULL DEFAULT true,

    -- Manual review / conversion (populated by E4+, never by E3)
    admin_notes TEXT,
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users(id),
    approved_templates JSONB,
    converted_user_id UUID REFERENCES users(id),

    -- Provenance (PII-safe — ip_hash only, never a raw IP)
    source TEXT,
    ip_hash TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_business_leads_status_created ON business_leads(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_leads_created ON business_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_leads_email ON business_leads(email);

-- Auto-update updated_at (reuse shared function; create it if this migration
-- runs standalone against a DB that predates the trigger function).
DO $do$
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
END $do$;

DROP TRIGGER IF EXISTS business_leads_updated_at ON business_leads;
CREATE TRIGGER business_leads_updated_at
  BEFORE UPDATE ON business_leads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
