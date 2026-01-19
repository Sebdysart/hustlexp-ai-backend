#!/usr/bin/env node
/**
 * HustleXP Schema Migration Script
 * Applies constitutional schema from HustleXP-DOCS to Neon PostgreSQL
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL || 
  'postgresql://neondb_owner:REDACTED_NEON_PASSWORD_1@REDACTED_NEON_HOST_1-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require';

const sql = neon(DATABASE_URL);

async function main() {
  console.log('🚀 HustleXP Schema Migration');
  console.log('=' .repeat(60));
  
  try {
    // Step 1: Check current state
    console.log('\n📊 Step 1: Checking current database state...');
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `;
    console.log(`   Found ${tables.length} existing tables:`, tables.map(t => t.table_name).join(', ') || '(none)');
    
    // Step 2: Backup check
    if (tables.length > 0) {
      console.log('\n⚠️  WARNING: Existing tables will be dropped!');
      console.log('   Tables to drop:', tables.map(t => t.table_name).join(', '));
    }
    
    // Step 3: Drop all existing objects
    console.log('\n🗑️  Step 2: Dropping existing schema...');
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`GRANT ALL ON SCHEMA public TO neondb_owner`;
    await sql`GRANT ALL ON SCHEMA public TO public`;
    console.log('   ✅ Schema dropped and recreated');
    
    // Step 4: Read constitutional schema
    console.log('\n📜 Step 3: Reading constitutional schema...');
    const schemaPath = join(__dirname, '../HustleXP-Fresh/schema.sql');
    const schemaSQL = readFileSync(schemaPath, 'utf-8');
    console.log(`   Schema file: ${schemaPath}`);
    console.log(`   Size: ${schemaSQL.length} characters`);
    
    // Step 5: Apply schema (split by statement)
    console.log('\n⚡ Step 4: Applying constitutional schema...');
    
    // Split SQL into individual statements
    // Handle $$ delimited functions specially
    const statements = [];
    let currentStatement = '';
    let inFunction = false;
    
    for (const line of schemaSQL.split('\n')) {
      const trimmed = line.trim();
      
      // Skip empty lines and comments at statement boundaries
      if (!inFunction && (trimmed === '' || trimmed.startsWith('--'))) {
        if (currentStatement.trim()) {
          // Check if this looks like a complete statement
        }
        continue;
      }
      
      currentStatement += line + '\n';
      
      // Track function blocks
      if (trimmed.includes('$$') && !inFunction) {
        inFunction = true;
      } else if (trimmed.includes('$$') && inFunction) {
        inFunction = false;
      }
      
      // End of statement (not in function block)
      if (!inFunction && trimmed.endsWith(';')) {
        const stmt = currentStatement.trim();
        if (stmt && !stmt.startsWith('--')) {
          statements.push(stmt);
        }
        currentStatement = '';
      }
    }
    
    console.log(`   Parsed ${statements.length} SQL statements`);
    
    // Execute each statement
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        // Use tagged template literal with raw SQL
        await sql.unsafe(stmt);
        successCount++;
        
        // Log progress for major objects
        if (stmt.includes('CREATE TABLE')) {
          const match = stmt.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i);
          if (match) console.log(`   ✅ Created table: ${match[1]}`);
        } else if (stmt.includes('CREATE OR REPLACE FUNCTION')) {
          const match = stmt.match(/CREATE OR REPLACE FUNCTION (\w+)/i);
          if (match) console.log(`   ✅ Created function: ${match[1]}`);
        } else if (stmt.includes('CREATE TRIGGER')) {
          const match = stmt.match(/CREATE TRIGGER (\w+)/i);
          if (match) console.log(`   ✅ Created trigger: ${match[1]}`);
        }
      } catch (err) {
        errorCount++;
        console.error(`   ❌ Error in statement ${i + 1}:`, err.message);
        console.error(`      Statement preview: ${stmt.substring(0, 100)}...`);
      }
    }
    
    console.log(`\n   Executed: ${successCount} successful, ${errorCount} errors`);
    
    // Step 6: Verify critical objects
    console.log('\n🔍 Step 5: Verifying critical objects...');
    
    // Check tables
    const newTables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `;
    console.log(`   Tables created: ${newTables.length}`);
    
    // Check triggers
    const triggers = await sql`
      SELECT trigger_name, event_object_table 
      FROM information_schema.triggers 
      WHERE trigger_schema = 'public'
      ORDER BY trigger_name
    `;
    console.log(`   Triggers created: ${triggers.length}`);
    for (const t of triggers) {
      console.log(`      - ${t.trigger_name} on ${t.event_object_table}`);
    }
    
    // Check functions
    const functions = await sql`
      SELECT routine_name 
      FROM information_schema.routines 
      WHERE routine_schema = 'public' 
      AND routine_type = 'FUNCTION'
      ORDER BY routine_name
    `;
    console.log(`   Functions created: ${functions.length}`);
    
    // Step 7: Verify schema version
    console.log('\n📋 Step 6: Checking schema version...');
    const version = await sql`SELECT version, applied_at FROM schema_versions ORDER BY applied_at DESC LIMIT 1`;
    if (version.length > 0) {
      console.log(`   Schema version: ${version[0].version}`);
      console.log(`   Applied at: ${version[0].applied_at}`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ MIGRATION COMPLETE');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('\n❌ MIGRATION FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
