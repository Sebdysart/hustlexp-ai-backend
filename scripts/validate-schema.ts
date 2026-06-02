#!/usr/bin/env tsx
/**
 * Schema Validation Script v1.0.0
 *
 * Extracts live schema from PostgreSQL, computes SHA256 hash for CI validation,
 * verifies critical tables exist, and validates financial invariant triggers.
 *
 * Usage:
 *   tsx scripts/validate-schema.ts
 *   SCHEMA_HASH=abc123... tsx scripts/validate-schema.ts  # CI enforcement mode
 *
 * Features:
 * - Extract tables/columns from information_schema.columns
 * - Extract indexes from pg_indexes
 * - Extract triggers from information_schema.triggers
 * - Compute SHA256 hash of canonicalized schema
 * - Verify critical financial tables exist
 * - Verify financial invariant triggers are present
 */

import { createHash } from 'crypto';
import { db } from '../backend/src/db.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Critical tables that must exist for the application to function */
const CRITICAL_TABLES = [
  'users',
  'tasks',
  'escrows',
  'ledger_entries',
  'payments',
  'ai_cost_logs',
  'proof_submissions',
];

/**
 * Columns the proof-review + completion paths require. Drift guard for
 * migration 011-proof-alignment.sql (proof_submissions + strict progress_state
 * + geo/photo cols). Missing any of these breaks task.reviewProof / task.complete.
 */
const REQUIRED_COLUMNS: { table: string; column: string }[] = [
  { table: 'tasks', column: 'progress_state' },
  { table: 'tasks', column: 'location_lat' },
  { table: 'tasks', column: 'location_lng' },
  { table: 'tasks', column: 'before_photo_url' },
  { table: 'proofs', column: 'state' },
  { table: 'proofs', column: 'reviewed_by' },
  { table: 'proofs', column: 'reviewed_at' },
  { table: 'proofs', column: 'rejection_reason' },
  { table: 'proofs', column: 'submitted_at' },
];

/** Financial invariant triggers that must be present for data integrity */
const FINANCIAL_INVARIANT_TRIGGERS = [
  'xp_requires_released_escrow',
  'escrow_released_requires_completed_task',
  'task_completed_requires_accepted_proof',
  'task_terminal_guard',
  'escrow_terminal_guard',
];

// ============================================================================
// TYPES
// ============================================================================

export interface ColumnInfo {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

export interface IndexInfo {
  tablename: string;
  indexname: string;
  indexdef: string;
}

export interface TriggerInfo {
  trigger_name: string;
  event_manipulation: string;
  event_object_table: string;
  action_timing: string;
  action_statement: string;
}

export interface LiveSchema {
  tables: Record<string, ColumnInfo[]>;
  indexes: IndexInfo[];
  triggers: TriggerInfo[];
  extractedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  schemaHash: string;
  errors: string[];
  warnings: string[];
  details: {
    tablesFound: string[];
    tablesMissing: string[];
    triggersFound: string[];
    triggersMissing: string[];
    columnCount: number;
    indexCount: number;
    triggerCount: number;
  };
}

// ============================================================================
// SCHEMA EXTRACTION
// ============================================================================

/**
 * Extract all columns from information_schema.columns
 * Groups results by table name for easier processing
 */
export async function extractColumns(): Promise<Record<string, ColumnInfo[]>> {
  const result = await db.query<ColumnInfo>(`
    SELECT 
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  const tables: Record<string, ColumnInfo[]> = {};
  for (const row of result.rows) {
    if (!tables[row.table_name]) {
      tables[row.table_name] = [];
    }
    tables[row.table_name].push(row);
  }

  return tables;
}

/**
 * Extract all indexes from pg_indexes
 */
export async function extractIndexes(): Promise<IndexInfo[]> {
  const result = await db.query<IndexInfo>(`
    SELECT 
      tablename,
      indexname,
      indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `);

  return result.rows;
}

/**
 * Extract all triggers from information_schema.triggers
 */
export async function extractTriggers(): Promise<TriggerInfo[]> {
  const result = await db.query<TriggerInfo>(`
    SELECT 
      trigger_name,
      event_manipulation,
      event_object_table,
      action_timing,
      action_statement
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    ORDER BY event_object_table, trigger_name
  `);

  return result.rows;
}

/**
 * Extract complete live schema from database
 */
export async function extractLiveSchema(): Promise<LiveSchema> {
  const [tables, indexes, triggers] = await Promise.all([
    extractColumns(),
    extractIndexes(),
    extractTriggers(),
  ]);

  return {
    tables,
    indexes,
    triggers,
    extractedAt: new Date().toISOString(),
  };
}

// ============================================================================
// SCHEMA HASH COMPUTATION
// ============================================================================

/**
 * Canonicalize schema for consistent hashing
 * Removes non-deterministic elements like timestamps
 */
function canonicalizeSchema(schema: LiveSchema): string {
  // Create a deterministic representation
  const canonical = {
    tables: Object.entries(schema.tables)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tableName, columns]) => ({
        name: tableName,
        columns: columns
          .map((c) => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable,
            default: c.column_default,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      })),
    indexes: schema.indexes
      .map((i) => ({
        table: i.tablename,
        name: i.indexname,
        def: i.indexdef,
      }))
      .sort((a, b) => {
        const tableCmp = a.table.localeCompare(b.table);
        return tableCmp !== 0 ? tableCmp : a.name.localeCompare(b.name);
      }),
    triggers: schema.triggers
      .map((t) => ({
        name: t.trigger_name,
        table: t.event_object_table,
        event: t.event_manipulation,
        timing: t.action_timing,
      }))
      .sort((a, b) => {
        const tableCmp = a.table.localeCompare(b.table);
        return tableCmp !== 0 ? tableCmp : a.name.localeCompare(b.name);
      }),
  };

  return JSON.stringify(canonical, null, 0);
}

/**
 * Compute SHA256 hash of the schema
 */
export function computeSchemaHash(schema: LiveSchema): string {
  const canonical = canonicalizeSchema(schema);
  return createHash('sha256').update(canonical).digest('hex');
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Verify all critical tables exist
 */
function verifyCriticalTables(
  schema: LiveSchema
): { found: string[]; missing: string[] } {
  const tablesFound = Object.keys(schema.tables);
  const found = CRITICAL_TABLES.filter((t) => tablesFound.includes(t));
  const missing = CRITICAL_TABLES.filter((t) => !tablesFound.includes(t));

  return { found, missing };
}

/**
 * Verify all financial invariant triggers exist
 */
function verifyFinancialTriggers(
  schema: LiveSchema
): { found: string[]; missing: string[] } {
  const triggersFound = schema.triggers.map((t) => t.trigger_name);
  const found = FINANCIAL_INVARIANT_TRIGGERS.filter((t) =>
    triggersFound.includes(t)
  );
  const missing = FINANCIAL_INVARIANT_TRIGGERS.filter(
    (t) => !triggersFound.includes(t)
  );

  return { found, missing };
}

/**
 * Verify required proof-review / completion columns exist (migration 011).
 */
function verifyRequiredColumns(schema: LiveSchema): { missing: string[] } {
  const missing: string[] = [];
  for (const { table, column } of REQUIRED_COLUMNS) {
    const cols = schema.tables[table] || [];
    if (!cols.some((c) => c.column_name === column)) {
      missing.push(`${table}.${column}`);
    }
  }
  return { missing };
}

/**
 * Verify tasks.progress_state is strict: exists, NOT NULL, DEFAULT 'POSTED'
 * (migration 011). The CHECK constraint + null-row count are verified separately
 * via a live query in validateSchema().
 */
function verifyProgressStateStrict(schema: LiveSchema): string[] {
  const errs: string[] = [];
  const col = (schema.tables['tasks'] || []).find(
    (c) => c.column_name === 'progress_state'
  );
  if (!col) {
    errs.push('tasks.progress_state column is missing');
    return errs;
  }
  if (col.is_nullable !== 'NO') {
    errs.push('tasks.progress_state must be NOT NULL');
  }
  if (!col.column_default || !col.column_default.includes('POSTED')) {
    errs.push("tasks.progress_state must DEFAULT 'POSTED'");
  }
  return errs;
}

/**
 * Validate schema against requirements
 * Checks:
 * - Critical tables exist (incl. proof_submissions)
 * - Financial invariant triggers exist
 * - Required proof-review columns exist + tasks.progress_state strict (migration 011)
 * - Schema hash matches expected (if SCHEMA_HASH env var set)
 */
export async function validateSchema(): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Extract live schema
  const schema = await extractLiveSchema();

  // Compute hash
  const schemaHash = computeSchemaHash(schema);

  // Verify critical tables
  const { found: tablesFound, missing: tablesMissing } =
    verifyCriticalTables(schema);

  if (tablesMissing.length > 0) {
    errors.push(`Missing critical tables: ${tablesMissing.join(', ')}`);
  }

  // Verify financial invariant triggers
  const { found: triggersFound, missing: triggersMissing } =
    verifyFinancialTriggers(schema);

  if (triggersMissing.length > 0) {
    errors.push(
      `Missing financial invariant triggers: ${triggersMissing.join(', ')}`
    );
  }

  // Required proof-review / completion columns (migration 011)
  const { missing: columnsMissing } = verifyRequiredColumns(schema);
  if (columnsMissing.length > 0) {
    errors.push(`Missing required columns: ${columnsMissing.join(', ')}`);
  }

  // tasks.progress_state strict (NOT NULL + DEFAULT 'POSTED')
  for (const e of verifyProgressStateStrict(schema)) {
    errors.push(e);
  }

  // progress_state CHECK constraint + no NULL rows (live query)
  try {
    const chk = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname = 'tasks_progress_state_check') AS exists`
    );
    if (!chk.rows[0]?.exists) {
      errors.push('Missing CHECK constraint: tasks_progress_state_check');
    }
    const nulls = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tasks WHERE progress_state IS NULL`
    );
    if (nulls.rows[0] && Number(nulls.rows[0].n) > 0) {
      errors.push(`tasks.progress_state has ${nulls.rows[0].n} NULL row(s)`);
    }
  } catch (e) {
    warnings.push(
      `progress_state constraint/null check skipped: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  // CI enforcement: check against expected hash
  const expectedHash = process.env.SCHEMA_HASH;
  if (expectedHash) {
    if (schemaHash !== expectedHash) {
      errors.push(
        `Schema hash mismatch: expected ${expectedHash}, got ${schemaHash}`
      );
    }
  } else {
    warnings.push(
      'SCHEMA_HASH not set - skipping hash validation (set for CI enforcement)'
    );
  }

  // Calculate totals
  const columnCount = Object.values(schema.tables).reduce(
    (sum, cols) => sum + cols.length,
    0
  );

  return {
    valid: errors.length === 0,
    schemaHash,
    errors,
    warnings,
    details: {
      tablesFound,
      tablesMissing,
      triggersFound,
      triggersMissing,
      columnCount,
      indexCount: schema.indexes.length,
      triggerCount: schema.triggers.length,
    },
  };
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  console.log('🔍 Schema Validation Script v1.0.0\n');

  const startTime = Date.now();

  try {
    const result = await validateSchema();

    console.log('📊 Results:');
    console.log(`   Schema Hash: ${result.schemaHash}`);
    console.log(`   Columns: ${result.details.columnCount}`);
    console.log(`   Indexes: ${result.details.indexCount}`);
    console.log(`   Triggers: ${result.details.triggerCount}`);
    console.log('');

    console.log('✅ Critical Tables:');
    for (const table of CRITICAL_TABLES) {
      const status = result.details.tablesFound.includes(table) ? '✓' : '✗';
      console.log(`   ${status} ${table}`);
    }
    console.log('');

    console.log('🔒 Financial Invariant Triggers:');
    for (const trigger of FINANCIAL_INVARIANT_TRIGGERS) {
      const status = result.details.triggersFound.includes(trigger) ? '✓' : '✗';
      console.log(`   ${status} ${trigger}`);
    }
    console.log('');

    if (result.warnings.length > 0) {
      console.log('⚠️  Warnings:');
      for (const warning of result.warnings) {
        console.log(`   - ${warning}`);
      }
      console.log('');
    }

    if (result.errors.length > 0) {
      console.log('❌ Errors:');
      for (const error of result.errors) {
        console.log(`   - ${error}`);
      }
      console.log('');
    }

    const duration = Date.now() - startTime;

    if (result.valid) {
      console.log(`✅ Validation passed (${duration}ms)`);
      console.log(`   Schema Hash: ${result.schemaHash}`);
      process.exit(0);
    } else {
      console.log(`❌ Validation failed (${duration}ms)`);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Fatal error during validation:', error);
    process.exit(1);
  } finally {
    // Clean up database connections
    await db.close();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
