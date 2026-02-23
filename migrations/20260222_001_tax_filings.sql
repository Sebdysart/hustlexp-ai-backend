-- 1099-NEC Tax Filings
CREATE TABLE IF NOT EXISTS tax_filings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tax_year INTEGER NOT NULL,
  form_type VARCHAR(20) NOT NULL DEFAULT '1099-NEC',
  total_earnings_cents BIGINT NOT NULL,
  stripe_tax_form_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  filed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, tax_year, form_type)
);

CREATE INDEX IF NOT EXISTS idx_tax_filings_year_status ON tax_filings(tax_year, status);
CREATE INDEX IF NOT EXISTS idx_tax_filings_user_id ON tax_filings(user_id);
