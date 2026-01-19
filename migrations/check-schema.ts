import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config();

async function checkTables() {
  const sql = neon(process.env.DATABASE_URL!);
  
  console.log('🔍 Checking database schema...\n');
  
  const allTables = await sql`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;
  
  console.log('All tables in database:');
  allTables.forEach((t: any) => console.log(`  - ${t.table_name}`));
  
  const escrowTables = allTables.filter((t: any) => 
    t.table_name.toLowerCase().includes('escrow')
  );
  
  console.log('\nEscrow-related tables:');
  if (escrowTables.length === 0) {
    console.log('  (none found)');
  } else {
    escrowTables.forEach((t: any) => console.log(`  - ${t.table_name}`));
  }
}

checkTables().catch(console.error);
