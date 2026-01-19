/**
 * Check Malformed Events in alpha_telemetry
 */

import { db } from '../backend/src/db';

async function checkMalformedEvents() {
  const result = await db.query(`
    SELECT 
      id,
      event_group,
      state,
      role,
      trust_tier,
      task_id,
      timestamp
    FROM alpha_telemetry
    WHERE (state IS NULL OR role IS NULL OR trust_tier IS NULL)
      AND timestamp > NOW() - INTERVAL '1 hour'
    ORDER BY timestamp DESC
    LIMIT 20
  `);

  console.log(`Found ${result.rows.length} events with null required fields:\n`);
  
  result.rows.forEach((row, idx) => {
    console.log(`${idx + 1}. Event ID: ${row.id}`);
    console.log(`   Group: ${row.event_group}`);
    console.log(`   State: ${row.state} (${row.state === null ? 'NULL' : 'OK'})`);
    console.log(`   Role: ${row.role} (${row.role === null ? 'NULL' : 'OK'})`);
    console.log(`   Trust Tier: ${row.trust_tier} (${row.trust_tier === null ? 'NULL' : 'OK'})`);
    console.log(`   Task ID: ${row.task_id || 'NULL (OK for tier deltas)'}`);
    console.log(`   Timestamp: ${row.timestamp}`);
    console.log('');
  });
}

checkMalformedEvents();
