/**
 * Apply pending migrations to align database schema
 */

import { db } from '../backend/src/db';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const migrationsDir = path.join(__dirname, '../backend/database/migrations');

// Migrations to apply in order
const migrations = [
  'add_user_plans.sql',
  'add_sensitive_to_tasks.sql',
];

async function applyMigration(fileName: string): Promise<void> {
  const filePath = path.join(migrationsDir, fileName);
  const sql = fs.readFileSync(filePath, 'utf-8');
  
  console.log(`\n📋 Applying migration: ${fileName}`);
  try {
    await db.query(sql);
    console.log(`  ✅ ${fileName} applied successfully`);
  } catch (error: any) {
    // Check if error is "already exists" - that's OK
    if (error.code === '42P07' || error.code === '42710' || error.message.includes('already exists')) {
      console.log(`  ⚠️  ${fileName} already applied (skipping)`);
    } else {
      throw error;
    }
  }
}

async function verifySchema(): Promise<void> {
  console.log('\n🔍 Verifying schema...');
  
  // Check tasks.sensitive
  try {
    const tasksCheck = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'tasks' AND column_name = 'sensitive'
    `);
    if (tasksCheck.rowCount > 0) {
      console.log('  ✅ tasks.sensitive exists');
    } else {
      console.log('  ❌ tasks.sensitive missing');
      throw new Error('tasks.sensitive column missing');
    }
  } catch (error) {
    console.error('  ❌ Error checking tasks.sensitive:', error);
    throw error;
  }
  
  // Check users.plan
  try {
    const usersCheck = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'plan'
    `);
    if (usersCheck.rowCount > 0) {
      console.log('  ✅ users.plan exists');
    } else {
      console.log('  ❌ users.plan missing');
      throw new Error('users.plan column missing');
    }
  } catch (error) {
    console.error('  ❌ Error checking users.plan:', error);
    throw error;
  }
}

async function main() {
  console.log('🔄 Applying pending migrations...\n');
  
  for (const migration of migrations) {
    await applyMigration(migration);
  }
  
  await verifySchema();
  
  console.log('\n✅ Schema aligned');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Migration failed:', e);
  process.exit(1);
});
