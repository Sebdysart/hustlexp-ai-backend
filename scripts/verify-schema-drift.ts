/**
 * Schema Drift Verification Script
 * 
 * Compares actual database schema against canonical schema.sql
 */

import { db } from '../backend/src/db';

async function verifySchemaDrift() {
  console.log('🔍 Checking schema drift...\n');

  // Check users table
  const usersColumns = await db.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type 
     FROM information_schema.columns 
     WHERE table_name = 'users' 
       AND column_name IN ('trust_tier', 'is_verified', 'phone', 'stripe_customer_id', 'created_at')
     ORDER BY column_name`
  );
  console.log('Users table columns:', usersColumns.rows.map(r => r.column_name));

  // Check tasks table
  const tasksColumns = await db.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type 
     FROM information_schema.columns 
     WHERE table_name = 'tasks' 
       AND column_name IN ('risk_level', 'risk_tier', 'instant_mode', 'sensitive', 'state', 'worker_id', 'poster_id')
     ORDER BY column_name`
  );
  console.log('Tasks table columns:', tasksColumns.rows.map(r => r.column_name));

  // Check if worker_id exists
  const workerIdCheck = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns 
       WHERE table_name = 'tasks' AND column_name = 'worker_id'
     ) as exists`
  );
  console.log('\nworker_id exists in tasks:', workerIdCheck.rows[0]?.exists);

  // Check trust_ledger table
  const trustLedgerColumns = await db.query<{ column_name: string }>(
    `SELECT column_name 
     FROM information_schema.columns 
     WHERE table_name = 'trust_ledger' 
       AND column_name IN ('idempotency_key', 'event_source', 'changed_by', 'old_tier', 'new_tier')
     ORDER BY column_name`
  );
  console.log('Trust_ledger columns:', trustLedgerColumns.rows.map(r => r.column_name));

  // Check constraints
  const trustTierConstraint = await db.query<{ constraint_name: string; check_clause: string }>(
    `SELECT constraint_name, check_clause
     FROM information_schema.check_constraints
     WHERE constraint_name = 'users_trust_tier_check'`
  );
  console.log('\nTrust tier constraint:', trustTierConstraint.rows[0]?.check_clause);

  await db.end();
}

verifySchemaDrift().catch(console.error);
