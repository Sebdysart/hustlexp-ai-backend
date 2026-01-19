/**
 * Execute N2.3 Verification Submission Tables Migration
 * 
 * Runs migrations/20250117_n2_3_verification_submission_tables.sql
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
    'migrations/20250117_n2_3_verification_submission_tables.sql'
  );

  try {
    console.log('📋 Executing N2.3 Verification Submission Tables Migration...');
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
    console.log('Executing migration SQL...');
    await client.query(cleanedMigration);

    await client.query('COMMIT');
    console.log('✅ Migration executed successfully');

    // Verify migration
    console.log('\n📋 Verifying migration...');

    // Check tables exist
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
    }
    if (foundTables.includes('insurance_verifications')) {
      console.log('✅ insurance_verifications table exists');
    } else {
      console.log('❌ insurance_verifications table missing');
    }
    if (foundTables.includes('background_checks')) {
      console.log('✅ background_checks table exists');
    } else {
      console.log('❌ background_checks table missing');
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
