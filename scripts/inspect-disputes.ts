/**
 * Inspect disputes table schema.
 * Usage: npx tsx scripts/inspect-disputes.ts
 */

import 'dotenv/config';
import { db, hasDb } from '../backend/src/db.js';

if (!hasDb || !db) {
  console.error('Database not available (set DATABASE_URL)');
  process.exit(1);
}

async function inspectDisputesSchema() {
  console.log('Inspecting disputes schema...');
  const result = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'disputes'
     ORDER BY ordinal_position`
  );
  console.log('Columns:', JSON.stringify(result.rows, null, 2));
  await db.getPool().end();
  process.exit(0);
}

inspectDisputesSchema();
