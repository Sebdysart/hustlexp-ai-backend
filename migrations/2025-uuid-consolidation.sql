-- ======================================================================
-- MIGRATION PACKAGE: UUID CONSOLIDATION FOR MONEY SUBSYSTEM
-- ======================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Mapping table
CREATE TABLE IF NOT EXISTS migration_map (
    legacy_id TEXT PRIMARY KEY,
    new_uuid UUID NOT NULL
);

-- 2. Map legacy escrow_holds IDs
INSERT INTO migration_map (legacy_id, new_uuid)
SELECT DISTINCT task_id, gen_random_uuid()
FROM escrow_holds
WHERE task_id !~ '^[0-9a-fA-F-]{8}-'
ON CONFLICT DO NOTHING;

-- 3. Map legacy hustler_payouts IDs
INSERT INTO migration_map (legacy_id, new_uuid)
SELECT DISTINCT task_id, gen_random_uuid()
FROM hustler_payouts
WHERE task_id !~ '^[0-9a-fA-F-]{8}-'
AND task_id NOT IN (SELECT legacy_id FROM migration_map)
ON CONFLICT DO NOTHING;

-- 4. Rewrite escrow_holds.task_id
UPDATE escrow_holds e
SET task_id = m.new_uuid::text
FROM migration_map m
WHERE e.task_id = m.legacy_id;

-- 5. Rewrite hustler_payouts.task_id
UPDATE hustler_payouts h
SET task_id = m.new_uuid::text
FROM migration_map m
WHERE h.task_id = m.legacy_id;

-- 6. Ensure tasks exist for every mapped UUID
INSERT INTO tasks (id, client_id, assigned_hustler_id, status, title, category, recommended_price)
SELECT 
    m.new_uuid, 
    NULL, -- client_id is nullable? Check schema. It says REFERENCES ..., wait. 
          -- Line 40: client_id UUID REFERENCES users(id) ON DELETE CASCADE
          -- It does NOT say NOT NULL. So NULL is allowed? 
          -- Let's check line 41: title VARCHAR(255) NOT NULL
          -- Line 43: category VARCHAR(50) NOT NULL
          -- Line 45: recommended_price DECIMAL(10,2) NOT NULL
    NULL, 
    'legacy_migrated',
    'Legacy Task',   -- title
    'general',       -- category
    0.00             -- recommended_price
FROM migration_map m
LEFT JOIN tasks t ON t.id = m.new_uuid
WHERE t.id IS NULL;

-- 7. Convert task_id columns to UUID
ALTER TABLE escrow_holds
    ALTER COLUMN task_id TYPE UUID USING task_id::uuid;

ALTER TABLE hustler_payouts
    ALTER COLUMN task_id TYPE UUID USING task_id::uuid;

-- 8. Add FK constraints
ALTER TABLE escrow_holds
    ADD CONSTRAINT fk_escrow_task FOREIGN KEY (task_id) REFERENCES tasks(id);

ALTER TABLE hustler_payouts
    ADD CONSTRAINT fk_payout_task FOREIGN KEY (task_id) REFERENCES tasks(id);

-- ======================================================================
-- END OF MIGRATION
-- ======================================================================
