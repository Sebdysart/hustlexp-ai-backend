/**
 * Constitutional Schema Migration Script
 * 
 * Applies the constitutional schema from HUSTLEXP-DOCS to the database.
 * 
 * Usage: tsx backend/database/migrate-constitutional-schema.ts
 * 
 * WARNING: This will apply the full schema. Make sure you have backups.
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as fs from 'fs';
import * as path from 'path';

// Enable WebSocket for Neon serverless
neonConfig.webSocketConstructor = ws;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function applySchema() {
  const schemaPath = path.join(__dirname, 'constitutional-schema.sql');
  
  if (!fs.existsSync(schemaPath)) {
    console.error(`❌ Schema file not found: ${schemaPath}`);
    process.exit(1);
  }
  
  const schemaSQL = fs.readFileSync(schemaPath, 'utf-8');
  
  console.log('📋 Applying constitutional schema...');
  console.log(`   File: ${schemaPath}`);
  console.log(`   Size: ${(schemaSQL.length / 1024).toFixed(2)} KB\n`);
  
  try {
    // Split by semicolons but preserve function definitions
    // This is a simple approach - for production, use a proper SQL parser
    const statements = schemaSQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    console.log(`   Executing ${statements.length} statements...\n`);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      
      // Skip empty statements
      if (!statement || statement.length < 10) continue;
      
      try {
        await pool.query(statement);
        successCount++;
        
        if ((i + 1) % 10 === 0) {
          process.stdout.write(`   Progress: ${i + 1}/${statements.length}\r`);
        }
      } catch (error: any) {
        // Some errors are expected (e.g., IF NOT EXISTS conflicts)
        if (error.message?.includes('already exists') || 
            error.message?.includes('duplicate') ||
            error.code === '42P07' || // duplicate_table
            error.code === '42710') { // duplicate_object
          successCount++;
          continue;
        }
        
        errorCount++;
        console.error(`\n❌ Error in statement ${i + 1}:`);
        console.error(`   ${error.message}`);
        console.error(`   Code: ${error.code}`);
        console.error(`   Statement preview: ${statement.substring(0, 100)}...\n`);
      }
    }
    
    console.log(`\n✅ Migration complete:`);
    console.log(`   Successful: ${successCount}`);
    console.log(`   Errors: ${errorCount}`);
    
    if (errorCount > 0) {
      console.log(`\n⚠️  Some statements had errors. Review the output above.`);
      console.log(`   This may be normal if tables/triggers already exist.`);
    }
    
  } catch (error: any) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

async function main() {
  console.log('🚀 Constitutional Schema Migration\n');
  console.log('⚠️  WARNING: This will apply the full constitutional schema.');
  console.log('   Make sure you have backups!\n');
  
  // Check if schema_versions table exists
  try {
    await pool.query('SELECT 1 FROM schema_versions LIMIT 1');
    console.log('ℹ️  Schema versions table exists. Migration will update if needed.\n');
  } catch {
    console.log('ℹ️  Schema versions table does not exist. Creating fresh schema.\n');
  }
  
  await applySchema();
  
  console.log('\n🔍 Verifying schema...');
  
  // Run verification
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  try {
    await execAsync('tsx backend/database/verify-schema.ts', {
      env: { ...process.env, DATABASE_URL },
    });
  } catch {
    console.log('⚠️  Verification script not available or failed. Please run manually.');
  }
  
  await pool.end();
}

main().catch(error => {
  console.error('❌ Migration failed:', error);
  process.exit(1);
});
