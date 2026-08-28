/**
 * Repair hustler_payouts schema (add columns if missing).
 * Usage: npx tsx scripts/repair-hustler-payouts.ts
 */

import 'dotenv/config';
import { db, hasDb } from '../backend/src/db.js';

if (!hasDb || !db) {
  console.error('Database not available (set DATABASE_URL)');
  process.exit(1);
}

async function repairHustlerPayouts() {
  console.log('Repairing hustler_payouts schema...');
  try {
    await db.query(`
      ALTER TABLE hustler_payouts
      ADD COLUMN IF NOT EXISTS escrow_id TEXT,
      ADD COLUMN IF NOT EXISTS hustler_stripe_account_id TEXT,
      ADD COLUMN IF NOT EXISTS gross_amount_cents INTEGER,
      ADD COLUMN IF NOT EXISTS fee_cents INTEGER,
      ADD COLUMN IF NOT EXISTS net_amount_cents INTEGER,
      ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'standard'
    `);
    console.log('Columns added successfully.');
  } catch (e) {
    console.error('Error altering table:', e);
    process.exit(1);
  } finally {
    await db.getPool().end();
  }
  process.exit(0);
}

repairHustlerPayouts();
