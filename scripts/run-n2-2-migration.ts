/**
 * Execute N2.2 Cleanup Migration
 * 
 * Runs migrations/20250117_n2_2_cleanup_task_state_machine.sql
 */

import { Pool } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';
import { config } from '../backend/config';

const DATABASE_URL = process.env.DATABASE_URL || config.database.url;

if (!DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL not set');
  process.exit(1);
}

async function runMigration() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  const migrationPath = path.join(
    process.cwd(),
    'migrations/20250117_n2_2_cleanup_task_state_machine.sql'
  );

  try {
    console.log('📋 Executing N2.2 Cleanup Migration...');
    console.log('Migration file:', migrationPath);

    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Remove BEGIN/COMMIT and comments (we control transaction)
    const cleanedMigration = migrationSql
      .replace(/^BEGIN;/gm, '')
      .replace(/^COMMIT;/gm, '')
      // Remove single-line comments (but preserve statement structure)
      .replace(/--.*$/gm, '')
      // Remove multi-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '');

    await client.query('BEGIN');

    // Execute the cleaned SQL as a single block
    // This is safer for complex ALTER TABLE statements with embedded comments
    console.log('Executing migration SQL...');
    await client.query(cleanedMigration);

    await client.query('COMMIT');
    console.log('✅ Migration executed successfully');

    // Verify migration
    console.log('\n📋 Verifying migration...');

    // Check WORKING state exists in CHECK constraint
    const constraintResult = await client.query(`
      SELECT pg_get_constraintdef(oid) as constraint_def
      FROM pg_constraint
      WHERE conname = 'tasks_state_check'
        AND conrelid = 'tasks'::regclass
    `);

    if (constraintResult.rows.length > 0) {
      const constraintDef = constraintResult.rows[0].constraint_def;
      if (constraintDef.includes("'WORKING'")) {
        console.log('✅ WORKING state found in CHECK constraint');
      } else {
        console.log('⚠️  WORKING state not found in CHECK constraint');
      }
    }

    // Check timestamp columns exist
    const columnsResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'tasks'
        AND column_name IN ('en_route_at', 'arrived_at')
    `);

    const foundColumns = columnsResult.rows.map(r => r.column_name);
    if (foundColumns.includes('en_route_at')) {
      console.log('✅ en_route_at column exists');
    } else {
      console.log('❌ en_route_at column missing');
    }

    if (foundColumns.includes('arrived_at')) {
      console.log('✅ arrived_at column exists');
    } else {
      console.log('❌ arrived_at column missing');
    }

    // Check current task states
    const statesResult = await client.query(`
      SELECT DISTINCT state
      FROM tasks
      ORDER BY state
    `);

    console.log('\n📋 Current task states in database:');
    statesResult.rows.forEach((r: any) => console.log(`  - ${r.state}`));

    console.log('\n✅ Migration verification complete');

  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    if (err.detail) console.error('Detail:', err.detail);
    if (err.hint) console.error('Hint:', err.hint);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
