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

  const migrationPath = path.join(process.cwd(), 'migrations/20250117_v1_2_task_messaging.sql');

  try {
    console.log('📋 Executing V1.2 Task Messaging Migration...');
    console.log('Migration file:', migrationPath);

    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Execute the entire SQL file as one atomic operation
    await client.query('BEGIN');
    await client.query(migrationSql); // Execute as a single block
    await client.query('COMMIT');
    console.log('✅ Migration executed successfully');

    // Verify tables exist
    console.log('\n📋 Verifying migration...');

    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('task_conversations', 'task_messages')
      ORDER BY table_name
    `);

    const foundTables = tablesResult.rows.map((r: any) => r.table_name);
    
    if (foundTables.includes('task_conversations')) {
      console.log('✅ task_conversations table exists');
    } else {
      console.log('❌ task_conversations table missing');
      throw new Error('task_conversations table not found');
    }
    
    if (foundTables.includes('task_messages')) {
      console.log('✅ task_messages table exists');
    } else {
      console.log('❌ task_messages table missing');
      throw new Error('task_messages table not found');
    }

    // Verify indexes exist
    const indexesResult = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND (
          indexname LIKE '%task_conversations%'
          OR indexname LIKE '%task_messages%'
        )
      ORDER BY indexname
    `);

    const foundIndexes = indexesResult.rows.map((r: any) => r.indexname);
    console.log(`\n📋 Found ${foundIndexes.length} indexes:`);
    foundIndexes.forEach(idx => console.log(`  ✅ ${idx}`));

    // Verify unique constraint on task_conversations.task_id
    const constraintsResult = await client.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'task_conversations'::regclass
        AND contype = 'u'
    `);

    if (constraintsResult.rows.length > 0) {
      console.log(`\n✅ UNIQUE constraint found on task_conversations (task_id)`);
    } else {
      console.log(`\n⚠️  UNIQUE constraint not found on task_conversations.task_id`);
    }

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
