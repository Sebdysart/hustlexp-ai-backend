ALTER TABLE ops_business_claim_links
ADD COLUMN quote_id uuid NULL
REFERENCES quotes(id);

CREATE INDEX IF NOT EXISTS idx_ops_business_claim_links_quote_id
ON ops_business_claim_links (quote_id);