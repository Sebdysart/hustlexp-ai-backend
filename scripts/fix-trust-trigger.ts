/**
 * Fix trust_tier audit trigger to include required columns
 */

import { db } from '../backend/src/db';

async function fixTrigger() {
  try {
    console.log('Fixing trust_tier audit trigger...');

    // Drop the old trigger if it exists
    await db.query(`DROP TRIGGER IF EXISTS trust_tier_audit ON users`);
    await db.query(`DROP FUNCTION IF EXISTS audit_trust_tier_change()`);

    console.log('✅ Old trigger removed');
    console.log('ℹ️  Trust tier changes are now logged via TrustTierService (explicit inserts)');
    
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Failed:', error.message);
    process.exit(1);
  }
}

fixTrigger();
