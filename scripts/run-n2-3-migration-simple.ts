/**
 * Execute N2.3 Migration (Simple Version)
 * Executes SQL file directly without complex comment parsing
 */

import { Pool } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL not set');
  process.exit(1);
}

async function runMigration() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  const migrationPath = path.join(process.cwd(), 'migrations/20250117_n2_3_verification_submission_tables.sql');

  try {
    console.log('📋 Executing N2.3 Verification Submission Tables Migration...');
    console.log('Migration file:', migrationPath);

    let migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Remove ONLY BEGIN/COMMIT (PostgreSQL handles comments natively)
    const cleanedMigration = migrationSql
      .replace(/^BEGIN;/gm, '')
      .replace(/^COMMIT;/gm, '');

    await client.query('BEGIN');

    // Execute the SQL as-is (PostgreSQL handles comments and multi-line SQL)
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
        AND table_name IN ('license_verifications', 'insurance_verifications', 'background_checks')
      ORDER BY table_name
    `);

    const foundTables = tablesResult.rows.map((r: any) => r.table_name);
    
    if (foundTables.includes('license_verifications')) {
      console.log('✅ license_verifications table exists');
    } else {
      console.log('❌ license_verifications table missing');
      throw new Error('license_verifications table not found');
    }
    
    if (foundTables.includes('insurance_verifications')) {
      console.log('✅ insurance_verifications table exists');
    } else {
      console.log('❌ insurance_verifications table missing');
      throw new Error('insurance_verifications table not found');
    }
    
    if (foundTables.includes('background_checks')) {
      console.log('✅ background_checks table exists');
    } else {
      console.log('❌ background_checks table missing');
      throw new Error('background_checks table not found');
    }

    // Verify indexes exist
    const indexesResult = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE '%_pending_unique'
      ORDER BY indexname
    `);

    const foundIndexes = indexesResult.rows.map((r: any) => r.indexname);
    console.log(`\n📋 Found ${foundIndexes.length} idempotency indexes:`);
    foundIndexes.forEach(idx => console.log(`  ✅ ${idx}`));

    console.log('\n✅ Migration verification complete');

  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    if (err.detail) console.error('Detail:', err.detail);
    if (err.hint) console.error('Hint:', err.hint);
    if (err.position) console.error('Position:', err.position);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
