-- Forward repair for databases that applied the expansion contract with an
-- immediate target foreign key. The request and target are created in the same
-- transaction and mutually reference one another, so commit-time validation is
-- required without weakening referential integrity.

ALTER TABLE liquidity_expansion_requests
  DROP CONSTRAINT IF EXISTS liquidity_expansion_requests_target_cell_id_fkey;

ALTER TABLE liquidity_expansion_requests
  ADD CONSTRAINT liquidity_expansion_requests_target_cell_id_fkey
  FOREIGN KEY (target_cell_id) REFERENCES zone_category_cells(id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
