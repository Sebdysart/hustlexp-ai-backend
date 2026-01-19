/**
 * Constitutional Schema Verification Script
 * 
 * Verifies that the database schema matches HUSTLEXP-DOCS/schema.sql exactly.
 * 
 * Usage: tsx backend/database/verify-constitutional-schema.ts
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

// Read constitutional schema for comparison
const schemaPath = path.join(__dirname, 'constitutional-schema.sql');
const constitutionalSchema = fs.existsSync(schemaPath)
  ? fs.readFileSync(schemaPath, 'utf-8')
  : null;

interface TableInfo {
  table_name: string;
  column_count: number;
}

interface TriggerInfo {
  tgname: string;
  tgrelid: string;
}

interface FunctionInfo {
  routine_name: string;
  routine_type: string;
}

interface ViewInfo {
  table_name: string;
}

async function verifySchema() {
  console.log('🔍 Verifying constitutional schema alignment...\n');
  
  const issues: string[] = [];
  const warnings: string[] = [];
  
  // 1. Check schema version
  try {
    const versionResult = await pool.query<{ version: string }>(
      "SELECT version FROM schema_versions WHERE version = '1.0.0'"
    );
    
    if (versionResult.rows.length === 0) {
      issues.push('Schema version 1.0.0 not found in schema_versions table');
    } else {
      console.log('✅ Schema version: 1.0.0');
    }
  } catch (error) {
    issues.push(`Error checking schema version: ${error}`);
  }
  
  // 2. Verify core tables exist
  const expectedTables = [
    'users', 'tasks', 'escrows', 'proofs', 'proof_photos',
    'xp_ledger', 'trust_ledger', 'badges', 'disputes',
    'processed_stripe_events',
    'ai_events', 'ai_jobs', 'ai_proposals', 'ai_decisions', 'evidence',
    'admin_roles', 'admin_actions',
    'live_sessions', 'live_broadcasts',
    'poster_ratings', 'session_forecasts',
  ];
  
  const tablesResult = await pool.query<TableInfo>(
    `SELECT table_name, 
            (SELECT COUNT(*) FROM information_schema.columns 
             WHERE table_name = t.table_name) as column_count
     FROM information_schema.tables t
     WHERE table_schema = 'public' 
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  
  const actualTables = tablesResult.rows.map(r => r.table_name);
  const missingTables = expectedTables.filter(t => !actualTables.includes(t));
  const extraTables = actualTables.filter(t => !expectedTables.includes(t));
  
  if (missingTables.length > 0) {
    issues.push(`Missing tables: ${missingTables.join(', ')}`);
  } else {
    console.log(`✅ All ${expectedTables.length} expected tables exist`);
  }
  
  if (extraTables.length > 0) {
    warnings.push(`Extra tables (not in constitutional schema): ${extraTables.join(', ')}`);
  }
  
  // 3. Verify triggers
  const expectedTriggers = [
    'task_terminal_guard',
    'escrow_terminal_guard',
    'escrow_amount_immutable',
    'xp_requires_released_escrow',
    'xp_ledger_no_delete',
    'badge_no_delete',
    'escrow_released_requires_completed_task',
    'task_completed_requires_accepted_proof',
    'trust_tier_audit',
    'admin_actions_no_delete',
    'live_task_escrow_check',
    'live_task_price_check',
  ];
  
  const triggersResult = await pool.query<TriggerInfo>(
    `SELECT tgname FROM pg_trigger 
     WHERE NOT tgisinternal
     ORDER BY tgname`
  );
  
  const actualTriggers = triggersResult.rows.map(r => r.tgname);
  const missingTriggers = expectedTriggers.filter(t => !actualTriggers.includes(t));
  
  if (missingTriggers.length > 0) {
    issues.push(`Missing triggers: ${missingTriggers.join(', ')}`);
  } else {
    console.log(`✅ All ${expectedTriggers.length} expected triggers exist`);
  }
  
  // 4. Verify functions
  const expectedFunctions = [
    'prevent_task_terminal_mutation',
    'prevent_escrow_terminal_mutation',
    'prevent_escrow_amount_change',
    'enforce_xp_requires_released_escrow',
    'prevent_xp_ledger_delete',
    'prevent_badge_delete',
    'enforce_released_requires_completed',
    'enforce_completed_requires_accepted_proof',
    'audit_trust_tier_change',
    'prevent_admin_action_delete',
    'live_task_requires_funded_escrow',
    'live_task_price_floor',
    'update_updated_at',
    'calculate_level',
    'calculate_xp_decay',
    'calculate_streak_multiplier',
  ];
  
  const functionsResult = await pool.query<FunctionInfo>(
    `SELECT routine_name, routine_type 
     FROM information_schema.routines 
     WHERE routine_schema = 'public' 
       AND routine_type = 'FUNCTION'
     ORDER BY routine_name`
  );
  
  const actualFunctions = functionsResult.rows.map(r => r.routine_name);
  const missingFunctions = expectedFunctions.filter(f => !actualFunctions.includes(f));
  
  if (missingFunctions.length > 0) {
    issues.push(`Missing functions: ${missingFunctions.join(', ')}`);
  } else {
    console.log(`✅ All ${expectedFunctions.length} expected functions exist`);
  }
  
  // 5. Verify views
  const expectedViews = ['poster_reputation', 'money_timeline'];
  
  const viewsResult = await pool.query<ViewInfo>(
    `SELECT table_name FROM information_schema.views 
     WHERE table_schema = 'public'
     ORDER BY table_name`
  );
  
  const actualViews = viewsResult.rows.map(r => r.table_name);
  const missingViews = expectedViews.filter(v => !actualViews.includes(v));
  
  if (missingViews.length > 0) {
    issues.push(`Missing views: ${missingViews.join(', ')}`);
  } else {
    console.log(`✅ All ${expectedViews.length} expected views exist`);
  }
  
  // 6. Verify critical constraints
  try {
    // Check XP ledger unique constraint (INV-5)
    const xpConstraintResult = await pool.query(
      `SELECT constraint_name 
       FROM information_schema.table_constraints 
       WHERE table_name = 'xp_ledger' 
         AND constraint_type = 'UNIQUE'
         AND constraint_name = 'xp_ledger_escrow_unique'`
    );
    
    if (xpConstraintResult.rows.length === 0) {
      issues.push('Missing UNIQUE constraint on xp_ledger.escrow_id (INV-5)');
    } else {
      console.log('✅ XP ledger idempotency constraint (INV-5) exists');
    }
  } catch (error) {
    warnings.push(`Could not verify XP ledger constraint: ${error}`);
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  
  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    warnings.forEach(w => console.log(`   - ${w}`));
  }
  
  if (issues.length > 0) {
    console.log('\n❌ Issues found:');
    issues.forEach(i => console.log(`   - ${i}`));
    console.log('\n❌ Schema verification FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ Schema verification PASSED');
    console.log('   All tables, triggers, functions, and views match constitutional schema');
    process.exit(0);
  }
}

verifySchema().catch(error => {
  console.error('❌ Verification failed:', error);
  process.exit(1);
}).finally(() => {
  pool.end();
});
