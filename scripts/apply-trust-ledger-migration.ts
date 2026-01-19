/**
 * Apply trust_ledger columns migration
 */

import { db } from '../backend/src/db';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function applyMigration() {
  try {
    console.log('Applying trust_ledger columns migration...');

    const migrationPath = join(__dirname, '../backend/database/migrations/add_trust_ledger_columns.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf-8');

    // Execute migration statements one by one
    const statements = migrationSQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await db.query(statement);
          console.log(`✅ Executed: ${statement.substring(0, 50)}...`);
        } catch (error: any) {
          // Ignore "already exists" errors
          if (error.code === '42P07' || error.code === '42710' || error.message?.includes('already exists')) {
            console.log(`ℹ️  Skipped (already exists): ${statement.substring(0, 50)}...`);
          } else {
            throw error;
          }
        }
      }
    }

    console.log('✅ Migration applied successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

applyMigration();
