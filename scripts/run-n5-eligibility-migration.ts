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

  const migrationPath = path.join(process.cwd(), 'migrations/20250117_n5_eligibility_columns.sql');

  try {
    console.log('📋 Executing N5 Eligibility Columns Migration...');
    console.log('Migration file:', migrationPath);

    let migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Remove BEGIN/COMMIT (we control transaction)
    const cleanedMigration = migrationSql.replace(/^BEGIN;/gm, '').replace(/^COMMIT;/gm, '');

    await client.query('BEGIN');
    await client.query(cleanedMigration);
    await client.query('COMMIT');
    console.log('✅ Migration executed successfully');

    // Verify columns exist
    console.log('\n📋 Verifying migration...');

    const colsResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'tasks'
        AND column_name IN ('required_trade', 'required_trust_tier', 'insurance_required', 'background_check_required')
      ORDER BY column_name
    `);

    const foundCols = colsResult.rows.map((r: any) => r.column_name);
    
    ['required_trade', 'required_trust_tier', 'insurance_required', 'background_check_required'].forEach(col => {
      if (foundCols.includes(col)) {
        console.log(`✅ ${col} column exists`);
      } else {
        console.log(`❌ ${col} column missing`);
      }
    });

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
