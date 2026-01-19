/**
 * Check N2.2 Migration Status
 */

import { Pool } from '@neondatabase/serverless';
import { config } from '../backend/config';

const DATABASE_URL = process.env.DATABASE_URL || config.database.url;

if (!DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL not set');
  process.exit(1);
}

async function checkStatus() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    // Check constraint
    const constraintResult = await client.query(`
      SELECT pg_get_constraintdef(oid) as constraint_def
      FROM pg_constraint
      WHERE conname = 'tasks_state_check'
        AND conrelid = 'tasks'::regclass
    `);

    if (constraintResult.rows.length > 0) {
      const constraintDef = constraintResult.rows[0].constraint_def;
      console.log('📋 Current constraint:', constraintDef);
      if (constraintDef.includes("'WORKING'")) {
        console.log('✅ WORKING state found in CHECK constraint');
      } else {
        console.log('❌ WORKING state NOT found in CHECK constraint');
      }
    } else {
      console.log('❌ tasks_state_check constraint not found');
    }

    // Check timestamp columns
    const columnsResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'tasks'
        AND column_name IN ('en_route_at', 'arrived_at')
    `);

    const foundColumns = columnsResult.rows.map((r: any) => r.column_name);
    console.log('\n📋 Timestamp columns:');
    if (foundColumns.includes('en_route_at')) {
      console.log('✅ en_route_at exists');
    } else {
      console.log('❌ en_route_at missing');
    }
    if (foundColumns.includes('arrived_at')) {
      console.log('✅ arrived_at exists');
    } else {
      console.log('❌ arrived_at missing');
    }

    // Check current states
    const statesResult = await client.query(`
      SELECT DISTINCT state
      FROM tasks
      ORDER BY state
    `);

    console.log('\n📋 Current task states in database:');
    if (statesResult.rows.length === 0) {
      console.log('  (no tasks in database)');
    } else {
      statesResult.rows.forEach((r: any) => console.log(`  - ${r.state}`));
    }

  } catch (err: any) {
    console.error('❌ Check failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

checkStatus();
