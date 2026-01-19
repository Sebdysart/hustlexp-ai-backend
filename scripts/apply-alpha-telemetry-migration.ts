/**
 * Apply Alpha Telemetry Migration
 * 
 * Creates the alpha_telemetry table with all required columns and indexes.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';
const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATABASE_URL = process.env.DATABASE_URL || 
  'postgresql://neondb_owner:REDACTED_NEON_PASSWORD_1@REDACTED_NEON_HOST_1.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require';

async function applyMigration() {
  const migrationPath = join(__dirname, '../backend/database/migrations/add_alpha_telemetry_table.sql');
  const migrationSQL = readFileSync(migrationPath, 'utf-8');
  
  const isLocal = DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1');
  const pool = new Pool({ 
    connectionString: DATABASE_URL,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } })
  });
  
  const client = await pool.connect();
  
  try {
    console.log('Applying alpha_telemetry migration...');
    await client.query(migrationSQL);
    console.log('✅ Alpha telemetry migration applied successfully');
  } catch (error: any) {
    if (error.code === '42P07') {
      // Table already exists
      console.log('⚠️  alpha_telemetry table already exists (migration may have been applied)');
    } else {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

applyMigration().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
