/**
 * Check Capability Schema
 */

import { Pool } from '@neondatabase/serverless';
import { config } from '../backend/config';

const DATABASE_URL = process.env.DATABASE_URL || config.database.url;

if (!DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL not set');
  process.exit(1);
}

async function checkSchema() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    // Check if tables exist
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('capability_profiles', 'verified_trades')
      ORDER BY table_name
    `);

    console.log('📋 Tables found:', tablesResult.rows.map((r: any) => r.table_name));

    if (tablesResult.rows.length === 0) {
      console.log('⚠️  capability_profiles and verified_trades tables do not exist yet');
      console.log('   These tables should be created by the eligibility system migration');
      return;
    }

    // Check capability_profiles columns
    if (tablesResult.rows.some((r: any) => r.table_name === 'capability_profiles')) {
      const cols = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'capability_profiles'
        ORDER BY ordinal_position
      `);
      console.log('\n📋 capability_profiles columns:');
      cols.rows.forEach((c: any) => {
        console.log(`  - ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable})`);
      });
    }

    // Check verified_trades columns
    if (tablesResult.rows.some((r: any) => r.table_name === 'verified_trades')) {
      const cols = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'verified_trades'
        ORDER BY ordinal_position
      `);
      console.log('\n📋 verified_trades columns:');
      cols.rows.forEach((c: any) => {
        console.log(`  - ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable})`);
      });
    }

  } catch (err: any) {
    console.error('❌ Check failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

checkSchema();
