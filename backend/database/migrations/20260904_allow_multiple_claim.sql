DROP INDEX IF EXISTS ops_business_claim_links_one_open_per_draft_uq;

ALTER TABLE ops_business_claim_links
ADD COLUMN IF NOT EXISTS invited_organization_id UUID
REFERENCES business_organizations(id);

CREATE UNIQUE INDEX IF NOT EXISTS
ops_business_claim_links_one_open_per_business_per_draft_uq
ON ops_business_claim_links(task_draft_id, invited_organization_id)
WHERE status = 'OPEN';