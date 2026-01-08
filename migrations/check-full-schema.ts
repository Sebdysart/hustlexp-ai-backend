import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config();

async function checkSchema() {
  const sql = neon(process.env.DATABASE_URL!);
  
  console.log('🔍 Checking current database schema...\n');
  
  // Check all tables
  const tables = await sql`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;
  
  console.log('All tables (' + tables.length + '):');
  tables.forEach((t: any) => console.log(`  - ${t.table_name}`));
  
  // Check users columns
  console.log('\n\nusers table columns:');
  const userCols = await sql`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'users'
    ORDER BY ordinal_position
  `;
  userCols.forEach((c: any) => console.log(`  - ${c.column_name}: ${c.data_type} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''}`));
  
  // Check tasks columns
  console.log('\n\ntasks table columns:');
  const taskCols = await sql`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'tasks'
    ORDER BY ordinal_position
  `;
  taskCols.forEach((c: any) => console.log(`  - ${c.column_name}: ${c.data_type}`));
  
  // Check money_state_lock columns
  console.log('\n\nmoney_state_lock table columns:');
  const mslCols = await sql`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'money_state_lock'
    ORDER BY ordinal_position
  `;
  mslCols.forEach((c: any) => console.log(`  - ${c.column_name}: ${c.data_type}`));
  
  // Check xp_ledger columns (new table we created)
  console.log('\n\nxp_ledger table columns:');
  const xpCols = await sql`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'xp_ledger'
    ORDER BY ordinal_position
  `;
  xpCols.forEach((c: any) => console.log(`  - ${c.column_name}: ${c.data_type}`));
  
  // Check if completions table exists
  const completionsExists = tables.some((t: any) => t.table_name === 'completions');
  console.log('\n\ncompletions table exists:', completionsExists);
  
  if (completionsExists) {
    const compCols = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'completions'
      ORDER BY ordinal_position
    `;
    compCols.forEach((c: any) => console.log(`  - ${c.column_name}: ${c.data_type}`));
  }
  
  // Sample data counts
  console.log('\n\nData counts:');
  const counts = await sql`
    SELECT 
      (SELECT COUNT(*) FROM users) as users,
      (SELECT COUNT(*) FROM tasks) as tasks,
      (SELECT COUNT(*) FROM money_state_lock) as money_locks,
      (SELECT COUNT(*) FROM xp_ledger) as xp_events
  `;
  console.log('  Users:', counts[0].users);
  console.log('  Tasks:', counts[0].tasks);
  console.log('  Money locks:', counts[0].money_locks);
  console.log('  XP ledger entries:', counts[0].xp_events);
}

checkSchema().catch(console.error);
