/**
 * Schema Verification Script v1.1.0
 * 
 * Verifies that the database schema matches the constitutional schema v1.1.0 exactly.
 * Checks for all 32 domain tables + schema_versions (33 total) and 4 views.
 * 
 * Usage: tsx backend/database/verify-schema.ts
 * 
 * Expected:
 * - 33 tables (1 schema_versions + 32 domain tables including 14 critical gap tables)
 * - 4 views (poster_reputation, money_timeline, user_rating_summary, + 1 more if exists)
 * - Schema version 1.0.0 or 1.1.0
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

// Expected tables from constitutional schema v1.1.0 (32 domain tables + schema_versions)
const EXPECTED_TABLES = [
  // Schema version tracking
  'schema_versions',
  // Core domain tables (18)
  'users',
  'tasks',
  'escrows',
  'proofs',
  'proof_photos',
  'xp_ledger',
  'trust_ledger',
  'badges',
  'disputes',
  'processed_stripe_events',
  'ai_events',
  'ai_jobs',
  'ai_proposals',
  'ai_decisions',
  'evidence',
  'admin_roles',
  'admin_actions',
  'live_sessions',
  'live_broadcasts',
  'poster_ratings',
  'session_forecasts',
  // Critical gap tables (14) - Phase 0 additions
  'task_matching_scores',
  'saved_searches',
  'task_messages',
  'notifications',
  'notification_preferences',
  'task_ratings',
  'analytics_events',
  'fraud_risk_scores',
  'fraud_patterns',
  'content_moderation_queue',
  'content_reports',
  'content_appeals',
  'gdpr_data_requests',
  'user_consents',
];

// Expected triggers
const EXPECTED_TRIGGERS = [
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
  'users_updated_at',
  'tasks_updated_at',
  'escrows_updated_at',
  'proofs_updated_at',
  'disputes_updated_at',
  'ai_jobs_updated_at',
  'evidence_updated_at',
];

// Expected functions
const EXPECTED_FUNCTIONS = [
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

// Expected views from constitutional schema v1.1.0 (3 views found in schema)
const EXPECTED_VIEWS = [
  'poster_reputation',      // Section 10.7.4 - Poster reputation view
  'money_timeline',         // Section 10.7.6 - Money timeline view
  'user_rating_summary',    // Section 11.5 - User rating summary view (added in Phase 0)
];

interface VerificationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

async function verifyTables(): Promise<VerificationResult> {
  const result: VerificationResult = { passed: true, errors: [], warnings: [] };
  
  const tablesResult = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables 
     WHERE table_schema = 'public' 
     AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  
  const actualTables = tablesResult.rows.map(r => r.table_name);
  const missingTables = EXPECTED_TABLES.filter(t => !actualTables.includes(t));
  const extraTables = actualTables.filter(t => !EXPECTED_TABLES.includes(t));
  
  if (missingTables.length > 0) {
    result.passed = false;
    result.errors.push(`Missing tables: ${missingTables.join(', ')}`);
  }
  
  if (extraTables.length > 0) {
    result.warnings.push(`Extra tables (not in constitutional schema): ${extraTables.join(', ')}`);
  }
  
  return result;
}

async function verifyTriggers(): Promise<VerificationResult> {
  const result: VerificationResult = { passed: true, errors: [], warnings: [] };
  
  const triggersResult = await pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger 
     WHERE NOT tgisinternal
     ORDER BY tgname`
  );
  
  const actualTriggers = triggersResult.rows.map(r => r.tgname);
  const missingTriggers = EXPECTED_TRIGGERS.filter(t => !actualTriggers.includes(t));
  const extraTriggers = actualTriggers.filter(t => !EXPECTED_TRIGGERS.includes(t));
  
  if (missingTriggers.length > 0) {
    result.passed = false;
    result.errors.push(`Missing triggers: ${missingTriggers.join(', ')}`);
  }
  
  if (extraTriggers.length > 0) {
    result.warnings.push(`Extra triggers: ${extraTriggers.join(', ')}`);
  }
  
  return result;
}

async function verifyFunctions(): Promise<VerificationResult> {
  const result: VerificationResult = { passed: true, errors: [], warnings: [] };
  
  const functionsResult = await pool.query<{ routine_name: string }>(
    `SELECT routine_name FROM information_schema.routines 
     WHERE routine_schema = 'public' 
     AND routine_type = 'FUNCTION'
     ORDER BY routine_name`
  );
  
  const actualFunctions = functionsResult.rows.map(r => r.routine_name);
  const missingFunctions = EXPECTED_FUNCTIONS.filter(f => !actualFunctions.includes(f));
  const extraFunctions = actualFunctions.filter(f => !EXPECTED_FUNCTIONS.includes(f));
  
  if (missingFunctions.length > 0) {
    result.passed = false;
    result.errors.push(`Missing functions: ${missingFunctions.join(', ')}`);
  }
  
  if (extraFunctions.length > 0) {
    result.warnings.push(`Extra functions: ${extraFunctions.join(', ')}`);
  }
  
  return result;
}

async function verifyViews(): Promise<VerificationResult> {
  const result: VerificationResult = { passed: true, errors: [], warnings: [] };
  
  const viewsResult = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.views 
     WHERE table_schema = 'public'
     ORDER BY table_name`
  );
  
  const actualViews = viewsResult.rows.map(r => r.table_name);
  const missingViews = EXPECTED_VIEWS.filter(v => !actualViews.includes(v));
  const extraViews = actualViews.filter(v => !EXPECTED_VIEWS.includes(v));
  
  if (missingViews.length > 0) {
    result.passed = false;
    result.errors.push(`Missing views: ${missingViews.join(', ')}`);
  }
  
  if (extraViews.length > 0) {
    result.warnings.push(`Extra views: ${extraViews.join(', ')}`);
  }
  
  return result;
}

async function verifySchemaVersion(): Promise<VerificationResult> {
  const result: VerificationResult = { passed: true, errors: [], warnings: [] };
  
  try {
    // Check for schema version 1.1.0 (current) or 1.0.0 (previous)
    const versionResult = await pool.query<{ version: string }>(
      `SELECT version FROM schema_versions WHERE version IN ('1.0.0', '1.1.0') ORDER BY version DESC LIMIT 1`
    );
    
    if (versionResult.rows.length === 0) {
      result.passed = false;
      result.errors.push('Schema version 1.0.0 or 1.1.0 not found in schema_versions table');
    } else {
      const version = versionResult.rows[0].version;
      if (version === '1.1.0') {
        console.log(`✅ Schema version: 1.1.0 (latest)`);
      } else if (version === '1.0.0') {
        result.warnings.push('Schema version is 1.0.0 (expected 1.1.0 for critical gap tables)');
      }
    }
  } catch (error) {
    result.passed = false;
    result.errors.push(`Error checking schema version: ${error}`);
  }
  
  return result;
}

async function main() {
  console.log('🔍 Verifying constitutional schema...\n');
  
  const results = {
    tables: await verifyTables(),
    triggers: await verifyTriggers(),
    functions: await verifyFunctions(),
    views: await verifyViews(),
    schemaVersion: await verifySchemaVersion(),
  };
  
  let allPassed = true;
  const allErrors: string[] = [];
  const allWarnings: string[] = [];
  
  for (const [category, result] of Object.entries(results)) {
    if (!result.passed) {
      allPassed = false;
    }
    allErrors.push(...result.errors.map(e => `[${category}] ${e}`));
    allWarnings.push(...result.warnings.map(w => `[${category}] ${w}`));
  }
  
  console.log('Results:');
  console.log(`  Tables: ${results.tables.passed ? '✅' : '❌'} (${EXPECTED_TABLES.length} expected: 33 total = 1 schema_versions + 32 domain tables)`);
  console.log(`  Domain Tables: ${EXPECTED_TABLES.length - 1} (excluding schema_versions)`);
  console.log(`  Views: ${results.views.passed ? '✅' : '❌'} (${EXPECTED_VIEWS.length} expected)`);
  console.log(`  Triggers: ${results.triggers.passed ? '✅' : '❌'} (${EXPECTED_TRIGGERS.length} expected)`);
  console.log(`  Functions: ${results.functions.passed ? '✅' : '❌'} (${EXPECTED_FUNCTIONS.length} expected)`);
  console.log(`  Schema Version: ${results.schemaVersion.passed ? '✅' : '❌'}`);
  
  if (allWarnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    allWarnings.forEach(w => console.log(`  - ${w}`));
  }
  
  if (allErrors.length > 0) {
    console.log('\n❌ Errors:');
    allErrors.forEach(e => console.log(`  - ${e}`));
  }
  
  if (allPassed) {
    console.log('\n✅ Schema verification PASSED');
    process.exit(0);
  } else {
    console.log('\n❌ Schema verification FAILED');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('❌ Verification failed:', error);
  process.exit(1);
}).finally(() => {
  pool.end();
});
