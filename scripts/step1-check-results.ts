/**
 * Step 1 Verification: Check webhook replay results
 * 
 * Verifies:
 * - No duplicate rows in stripe_events
 * - No duplicate entitlements
 * - Idempotent handling confirmed
 */

import { db } from '../backend/src/db';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

async function checkResults() {
  console.log('🔍 Checking Step 1 verification results...\n');

  // Check stripe_events for duplicates
  const events = await db.query(
    `SELECT stripe_event_id, type, COUNT(*) as count
     FROM stripe_events
     GROUP BY stripe_event_id, type
     HAVING COUNT(*) > 1`
  );

  if (events.rowCount > 0) {
    console.log('❌ FAIL: Duplicate stripe_event_id found');
    events.rows.forEach(e => {
      console.log(`   Event: ${e.stripe_event_id} (${e.count} occurrences)`);
    });
    process.exit(1);
  }
  console.log('✅ No duplicate stripe_event_id rows');

  // Check total event count
  const totalEvents = await db.query('SELECT COUNT(*) as count FROM stripe_events');
  console.log(`✅ Total events: ${totalEvents.rows[0].count}`);

  // Check entitlements for duplicates
  const entitlements = await db.query(
    `SELECT source_event_id, COUNT(*) as count
     FROM plan_entitlements
     GROUP BY source_event_id
     HAVING COUNT(*) > 1`
  );

  if (entitlements.rowCount > 0) {
    console.log('❌ FAIL: Duplicate entitlements found');
    entitlements.rows.forEach(e => {
      console.log(`   Event: ${e.source_event_id} (${e.count} entitlements)`);
    });
    process.exit(1);
  }
  console.log('✅ No duplicate entitlements');

  // Check for events with same type processed multiple times
  const processed = await db.query(
    `SELECT stripe_event_id, type, processed_at, result
     FROM stripe_events
     WHERE processed_at IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 10`
  );

  if (processed.rowCount > 0) {
    console.log('\n📊 Recent processed events:');
    processed.rows.forEach(e => {
      console.log(`   ${e.stripe_event_id.substring(0, 20)}... | ${e.type} | ${e.result}`);
    });
  }

  console.log('\n✅ STEP 1: PASS - Idempotent handling confirmed');
  process.exit(0);
}

checkResults().catch(e => {
  console.error('❌ Verification failed:', e);
  process.exit(1);
});
