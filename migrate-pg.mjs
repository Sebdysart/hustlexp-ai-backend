#!/usr/bin/env node
/**
 * HustleXP Schema Migration - Using pg Pool
 */

import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

async function main() {
  // ── SAFETY GUARD ─────────────────────────────────────────────────────────
  // This script is DESTRUCTIVE: Step 2 runs `DROP SCHEMA public CASCADE` and
  // rebuilds from constitutional-schema.sql — it WIPES ALL DATA. It must never
  // run by accident (deploy release phase, a stray `db:migrate`/`db:check`, or a
  // local run pointed at a real DB). It is reachable only via the explicitly
  // named `npm run db:reset:destructive`, and only when BOTH conditions hold:
  //   1) HX_ALLOW_DESTRUCTIVE_MIGRATE=1 is set, AND
  //   2) NODE_ENV is not production/staging.
  // The checks run BEFORE any DB connection, so a refused run never drops or
  // even connects.
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'production' || nodeEnv === 'staging') {
    console.error(`🛑 REFUSED: destructive schema reset is blocked when NODE_ENV=${nodeEnv}.`);
    console.error('   migrate-pg.mjs runs DROP SCHEMA public CASCADE (full data wipe). Never in prod/staging.');
    process.exit(1);
  }
  if (process.env.HX_ALLOW_DESTRUCTIVE_MIGRATE !== '1') {
    console.error('🛑 REFUSED: destructive schema reset requires HX_ALLOW_DESTRUCTIVE_MIGRATE=1.');
    console.error('   migrate-pg.mjs runs DROP SCHEMA public CASCADE — full wipe + rebuild from constitutional-schema.sql.');
    console.error('   Dev resets only:  HX_ALLOW_DESTRUCTIVE_MIGRATE=1 NODE_ENV=development npm run db:reset:destructive');
    console.error('   To align an existing DB without wiping it, use the reviewed alignment process (NOT this script).');
    process.exit(1);
  }
  console.log('⚠️  HX_ALLOW_DESTRUCTIVE_MIGRATE=1 set — proceeding with DESTRUCTIVE schema reset.');
  // ─────────────────────────────────────────────────────────────────────────

  console.log('🚀 HustleXP Schema Migration (pg Pool)');
  console.log('=' .repeat(60));
  console.log('Database:', DATABASE_URL.replace(/:[^:@]+@/, ':***@'));
  
  // Railway internal and localhost don't need SSL; external DBs (Neon, Supabase) do
  const needsSSL = !DATABASE_URL.includes('localhost') &&
                   !DATABASE_URL.includes('127.0.0.1') &&
                   !DATABASE_URL.includes('.railway.internal');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ...(needsSSL ? { ssl: { rejectUnauthorized: false } } : {})
  });

  try {
    // Step 1: Check current state
    const client = await pool.connect();
    console.log('\n📊 Step 1: Checking current database state...');
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    console.log(`   Found ${tablesResult.rows.length} existing tables`);
    if (tablesResult.rows.length > 0) {
      console.log('   Tables:', tablesResult.rows.map(t => t.table_name).join(', '));
    }
    
    // Step 2: Drop existing schema
    console.log('\n🗑️  Step 2: Dropping existing schema...');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    // Grant to current user (works for both Neon and local Postgres)
    const currentUserResult = await client.query('SELECT current_user');
    const currentUser = currentUserResult.rows[0].current_user;
    await client.query(`GRANT ALL ON SCHEMA public TO ${currentUser}`);
    await client.query('GRANT ALL ON SCHEMA public TO public');
    console.log(`   ✅ Schema dropped and recreated (granted to ${currentUser})`);
    
    // Step 3: Read and apply schema
    console.log('\n📜 Step 3: Reading constitutional schema...');
    // Use constitutional-schema.sql (canonical schema)
    const schemaPath = join(__dirname, 'backend/database/constitutional-schema.sql');
    const schemaSQL = readFileSync(schemaPath, 'utf-8');
    console.log(`   Schema size: ${schemaSQL.length} characters`);
    
    console.log('\n⚡ Step 4: Applying schema (this may take a moment)...');
    
    // Execute the entire schema as one statement
    await client.query(schemaSQL);
    console.log('   ✅ Schema applied successfully');
    
    // Step 5: Verify
    console.log('\n🔍 Step 5: Verifying...');
    
    const newTables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    console.log(`   Tables: ${newTables.rows.length}`);
    newTables.rows.forEach(t => console.log(`      - ${t.table_name}`));
    
    const triggers = await client.query(`
      SELECT trigger_name, event_object_table 
      FROM information_schema.triggers 
      WHERE trigger_schema = 'public'
      ORDER BY trigger_name
    `);
    console.log(`   Triggers: ${triggers.rows.length}`);
    triggers.rows.forEach(t => console.log(`      - ${t.trigger_name} ON ${t.event_object_table}`));
    
    const version = await client.query('SELECT version, applied_at FROM schema_versions');
    if (version.rows.length > 0) {
      console.log(`   Schema version: ${version.rows[0].version}`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ MIGRATION COMPLETE');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('\n❌ MIGRATION FAILED:', error.message);
    if (error.position) {
      console.error('   Position:', error.position);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => process.exit(1));
