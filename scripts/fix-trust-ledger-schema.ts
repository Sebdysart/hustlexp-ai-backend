/**
 * Fix trust_ledger schema to match canonical
 */

import { db } from '../backend/src/db';

async function fixSchema() {
  try {
    console.log('Fixing trust_ledger schema...');

    // Check if columns exist
    const check = await db.query<{ column_name: string }>(
      `SELECT column_name 
       FROM information_schema.columns 
       WHERE table_name = 'trust_ledger' 
         AND column_name IN ('idempotency_key', 'event_source', 'source_event_id')`
    );
    
    const existing = check.rows.map(r => r.column_name);
    console.log('Existing columns:', existing);

    // Add missing columns
    if (!existing.includes('idempotency_key')) {
      await db.query(`ALTER TABLE trust_ledger ADD COLUMN idempotency_key VARCHAR(255)`);
      console.log('✅ Added idempotency_key');
    }

    if (!existing.includes('event_source')) {
      await db.query(`ALTER TABLE trust_ledger ADD COLUMN event_source VARCHAR(50)`);
      console.log('✅ Added event_source');
    }

    if (!existing.includes('source_event_id')) {
      await db.query(`ALTER TABLE trust_ledger ADD COLUMN source_event_id VARCHAR(255)`);
      console.log('✅ Added source_event_id');
    }

    // Backfill existing rows
    await db.query(`
      UPDATE trust_ledger 
      SET idempotency_key = 'legacy_' || id::text 
      WHERE idempotency_key IS NULL
    `);
    await db.query(`
      UPDATE trust_ledger 
      SET event_source = 'system' 
      WHERE event_source IS NULL
    `);

    // Make NOT NULL
    await db.query(`ALTER TABLE trust_ledger ALTER COLUMN idempotency_key SET NOT NULL`);
    await db.query(`ALTER TABLE trust_ledger ALTER COLUMN event_source SET NOT NULL`);

    // Create unique index
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_ledger_idempotency 
      ON trust_ledger(idempotency_key)
    `);

    console.log('✅ Schema fixed');
    process.exit(0);
  } catch (error: any) {
    if (error.code === '42710' || error.message?.includes('already exists')) {
      console.log('ℹ️  Column/index already exists, skipping');
      process.exit(0);
    }
    console.error('❌ Failed:', error.message);
    process.exit(1);
  }
}

fixSchema();
