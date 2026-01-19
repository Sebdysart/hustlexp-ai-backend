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
    const cols = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'tasks'
      ORDER BY ordinal_position
    `);
    
    console.log('📋 Tasks table columns:');
    cols.rows.forEach((c: any) => {
      console.log(`  - ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable})`);
    });
  } catch (err: any) {
    console.error('❌ Check failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

checkSchema();
