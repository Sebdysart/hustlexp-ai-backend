/**
 * Execute Eligibility System Tables Migration
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
    'migrations/20250117_eligibility_system_tables.sql'
  );

  try {
    console.log('📋 Executing Eligibility System Tables Migration...');
    console.log('Migration file:', migrationPath);

    let migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Remove BEGIN/COMMIT (we control transaction)
    const cleanedMigration = migrationSql
      .replace(/^BEGIN;/gm, '')
      .replace(/^COMMIT;/gm, '');

    await client.query('BEGIN');

    // Execute the SQL as-is (PostgreSQL handles comments)
    console.log('Executing migration SQL...');
    await client.query(cleanedMigration);

    await client.query('COMMIT');
    console.log('✅ Migration executed successfully');

    // Verify tables exist
    console.log('\n📋 Verifying migration...');

    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('capability_profiles', 'verified_trades')
      ORDER BY table_name
    `);

    const foundTables = tablesResult.rows.map((r: any) => r.table_name);
    
    if (foundTables.includes('capability_profiles')) {
      console.log('✅ capability_profiles table exists');
    } else {
      console.log('❌ capability_profiles table missing');
      throw new Error('capability_profiles table not found');
    }
    
    if (foundTables.includes('verified_trades')) {
      console.log('✅ verified_trades table exists');
    } else {
      console.log('❌ verified_trades table missing');
      throw new Error('verified_trades table not found');
    }

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
