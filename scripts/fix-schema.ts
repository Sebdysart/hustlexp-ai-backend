/**
 * Fix schema - add missing columns
 */

import { db } from '../backend/src/db';

async function fixSchema() {
  console.log('🔧 Fixing schema...\n');

  // Add risk_level column to tasks
  try {
    await db.query(`
      ALTER TABLE tasks 
      ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) NOT NULL DEFAULT 'LOW'
        CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME'))
    `);
    console.log('  ✅ Added risk_level to tasks');
  } catch (error: any) {
    if (!error.message.includes('already exists')) {
      throw error;
    }
    console.log('  ⚠️  risk_level already exists');
  }

  // Verify columns exist
  console.log('\n🔍 Verifying columns...');
  
  const tasksColumns = await db.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'tasks' 
    ORDER BY column_name
  `);
  
  const requiredColumns = ['risk_level', 'sensitive', 'instant_mode'];
  const existingColumns = tasksColumns.rows.map(r => r.column_name);
  
  for (const col of requiredColumns) {
    if (existingColumns.includes(col)) {
      console.log(`  ✅ tasks.${col} exists`);
    } else {
      console.log(`  ❌ tasks.${col} MISSING`);
    }
  }
  
  const usersColumns = await db.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'users' 
    ORDER BY column_name
  `);
  
  const existingUserColumns = usersColumns.rows.map(r => r.column_name);
  if (existingUserColumns.includes('plan')) {
    console.log(`  ✅ users.plan exists`);
  } else {
    console.log(`  ❌ users.plan MISSING`);
  }
  
  console.log('\n✅ Schema fix complete');
}

fixSchema().catch(e => {
  console.error('❌ Failed:', e);
  process.exit(1);
});
