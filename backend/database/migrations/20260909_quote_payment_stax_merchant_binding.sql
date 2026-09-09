ALTER TABLE quote_payments ADD COLUMN IF NOT EXISTS business_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT;
ALTER TABLE quote_payments ADD COLUMN IF NOT EXISTS provider_merchant_id TEXT;
ALTER TABLE quote_payments ADD COLUMN IF NOT EXISTS platform_fee_cents INTEGER CHECK (platform_fee_cents IS NULL OR platform_fee_cents >= 0);
CREATE INDEX IF NOT EXISTS quote_payments_business_organization_idx ON quote_payments(business_organization_id);

