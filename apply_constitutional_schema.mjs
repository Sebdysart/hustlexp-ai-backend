/**
 * Apply HustleXP Constitutional Schema to Neon Database
 * This script drops existing tables and applies the spec-compliant schema
 */

import { readFileSync } from 'fs';
import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = 'postgresql://neondb_owner:npg_jsckB8AHbJa5@ep-young-shape-af9wgdv0-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require';

async function applySchema() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  
  try {
    console.log('🔄 Connecting to Neon database...');
    const client = await pool.connect();
    
    // Step 1: Drop existing schema
    console.log('🗑️  Dropping existing schema...');
    await client.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO neondb_owner;
      GRANT ALL ON SCHEMA public TO public;
    `);
    console.log('✅ Schema dropped and recreated');
    
    // Step 2: Read constitutional schema
    console.log('📖 Reading constitutional schema...');
    const schemaPath = '/Users/sebastiandysart/HustleXP/HustleXP-Fresh/schema.sql';
    const schemaSql = readFileSync(schemaPath, 'utf8');
    console.log(`✅ Schema loaded (${schemaSql.length} characters)`);
    
    // Step 3: Apply schema
    console.log('⚡ Applying constitutional schema...');
    await client.query(schemaSql);
    console.log('✅ Constitutional schema applied');
    
    // Step 4: Verify tables
    console.log('🔍 Verifying tables...');
    const tablesResult = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log(`✅ Created ${tablesResult.rows.length} tables:`);
    tablesResult.rows.forEach(row => console.log(`   - ${row.table_name}`));
    
    // Step 5: Verify triggers
    console.log('🔍 Verifying triggers...');
    const triggersResult = await client.query(`
      SELECT tgname, relname as table_name
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      WHERE NOT tgisinternal
      ORDER BY relname, tgname;
    `);
    console.log(`✅ Created ${triggersResult.rows.length} triggers:`);
    triggersResult.rows.forEach(row => console.log(`   - ${row.tgname} ON ${row.table_name}`));
    
    // Step 6: Verify schema version
    console.log('🔍 Checking schema version...');
    const versionResult = await client.query(`SELECT version, applied_at FROM schema_versions ORDER BY applied_at DESC LIMIT 1`);
    if (versionResult.rows.length > 0) {
      console.log(`✅ Schema version: ${versionResult.rows[0].version}`);
    }
    
    client.release();
    console.log('\n🎉 CONSTITUTIONAL SCHEMA APPLIED SUCCESSFULLY');
    
  } catch (error) {
    console.error('❌ Error applying schema:', error.message);
    if (error.position) {
      console.error(`   Position: ${error.position}`);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

applySchema();
