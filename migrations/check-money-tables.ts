import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config();

async function checkMoneyTables() {
  const sql = neon(process.env.DATABASE_URL!);
  
  console.log('🔍 Checking money-related tables...\n');
  
  // Check money_state_lock structure
  console.log('money_state_lock columns:');
  const mslCols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'money_state_lock'
    ORDER BY ordinal_position
  `;
  mslCols.forEach((c: any) => console.log(`  - ${c.column_name} (${c.data_type})`));
  
  // Check tasks columns
  console.log('\ntasks columns (relevant):');
  const taskCols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'tasks'
    AND column_name IN ('status', 'payment_status', 'budget', 'price')
    ORDER BY column_name
  `;
  taskCols.forEach((c: any) => console.log(`  - ${c.column_name} (${c.data_type})`));
  
  // Check if xp_events exists
  console.log('\nxp-related tables:');
  const xpTables = await sql`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    AND table_name LIKE '%xp%' OR table_name LIKE '%event%'
    ORDER BY table_name
  `;
  xpTables.forEach((t: any) => console.log(`  - ${t.table_name}`));
  
  // Check badges
  console.log('\nbadge-related tables:');
  const badgeTables = await sql`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    AND table_name LIKE '%badge%'
    ORDER BY table_name
  `;
  if (badgeTables.length === 0) {
    console.log('  (none found)');
  } else {
    badgeTables.forEach((t: any) => console.log(`  - ${t.table_name}`));
  }
  
  // Check users columns
  console.log('\nusers columns:');
  const userCols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'users'
    ORDER BY ordinal_position
  `;
  userCols.forEach((c: any) => console.log(`  - ${c.column_name} (${c.data_type})`));
}

checkMoneyTables().catch(console.error);
