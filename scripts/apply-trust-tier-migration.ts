/**
 * Apply trust tier enum support migration
 */

import { db } from '../backend/src/db';

async function applyMigration() {
  try {
    console.log('Applying trust tier enum support migration...');

    // Drop existing constraint
    await db.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_trust_tier_check');

    // Add new constraint allowing 0 (UNVERIFIED), 1-4 (tiers), and 9 (BANNED)
    await db.query(`
      ALTER TABLE users 
      ADD CONSTRAINT users_trust_tier_check 
      CHECK (trust_tier IN (0, 1, 2, 3, 4, 9))
    `);

    // Update default to 0 (UNVERIFIED) instead of 1
    await db.query('ALTER TABLE users ALTER COLUMN trust_tier SET DEFAULT 0');

    console.log('✅ Migration applied successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

applyMigration();
