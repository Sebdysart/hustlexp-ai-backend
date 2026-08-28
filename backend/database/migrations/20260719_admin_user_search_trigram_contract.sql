-- HX/OS bounded administrator search contract.
-- Wildcard characters are escaped by the router; trigram indexes prevent the
-- remaining contains-search from degrading into an avoidable full-table scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm
  ON users USING GIN (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_users_email_trgm
  ON users USING GIN (email gin_trgm_ops);
