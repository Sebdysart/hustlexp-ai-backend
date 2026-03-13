#!/usr/bin/env tsx
/**
 * Migration Safety Analyzer
 *
 * Parses migration SQL files for dangerous patterns that could break
 * production data integrity. Designed for CI use in PR pipelines.
 *
 * Usage:
 *   npx tsx scripts/analyze-migration-safety.ts backend/database/migrations/20260222_008_foo.sql
 *   CHANGED_FILES="backend/database/migrations/foo.sql other/file.ts" npx tsx scripts/analyze-migration-safety.ts
 */

import { readFileSync, appendFileSync, existsSync } from 'fs';
import { basename } from 'path';

// ============================================================================
// CONSTANTS
// ============================================================================

export const CRITICAL_TABLES = [
  'users',
  'tasks',
  'escrows',
  'ledger_entries',
  'payments',
  'ai_cost_logs',
  'proof_submissions',
  'disputes',
];

export const FINANCIAL_TABLES = [
  'escrows',
  'ledger_entries',
  'payments',
];

export const CRITICAL_TRIGGERS = [
  'xp_requires_released_escrow',
  'escrow_released_requires_completed_task',
  'task_completed_requires_accepted_proof',
  'task_terminal_guard',
  'escrow_terminal_guard',
];

// ============================================================================
// TYPES
// ============================================================================

export interface SafetyIssue {
  severity: 'BLOCKER' | 'WARNING';
  message: string;
  file: string;
  line: number;
}

export interface SafetyResult {
  safe: boolean;
  migrationFiles: string[];
  blockers: string[];
  warnings: string[];
  affectedTables: string[];
  affectedTriggers: string[];
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

/** Build a regex-safe alternation for a list of names */
function namesPattern(names: string[]): string {
  return names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * Analyze a single migration SQL file for dangerous patterns.
 * Returns a list of safety issues found.
 */
export function analyzeMigrationFile(
  filePath: string,
  sql: string
): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const lines = sql.split('\n');
  const criticalTablesRe = namesPattern(CRITICAL_TABLES);
  const financialTablesRe = namesPattern(FINANCIAL_TABLES);
  const criticalTriggersRe = namesPattern(CRITICAL_TRIGGERS);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip SQL comments
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;

    const upper = line.toUpperCase();

    // 1. DROP TABLE on critical tables
    const dropTableMatch = line.match(
      new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?(?:"?)(${criticalTablesRe})(?:"?)`, 'i')
    );
    if (dropTableMatch) {
      issues.push({
        severity: 'BLOCKER',
        message: `DROP TABLE on critical table '${dropTableMatch[1]}' in ${filePath}:${lineNum}`,
        file: filePath,
        line: lineNum,
      });
    }

    // 2. DROP COLUMN on critical tables — look for ALTER TABLE <critical> ... DROP COLUMN
    const dropColumnMatch = line.match(
      new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?(?:"?)(${criticalTablesRe})(?:"?)\\s+.*DROP\\s+COLUMN`, 'i')
    );
    if (dropColumnMatch) {
      issues.push({
        severity: 'BLOCKER',
        message: `DROP COLUMN on critical table '${dropColumnMatch[1]}' in ${filePath}:${lineNum}`,
        file: filePath,
        line: lineNum,
      });
    }

    // 3. DROP TRIGGER on financial invariant triggers
    const dropTriggerMatch = line.match(
      new RegExp(`DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(?:"?)(${criticalTriggersRe})(?:"?)`, 'i')
    );
    if (dropTriggerMatch) {
      issues.push({
        severity: 'BLOCKER',
        message: `DROP TRIGGER on financial invariant trigger '${dropTriggerMatch[1]}' in ${filePath}:${lineNum}`,
        file: filePath,
        line: lineNum,
      });
    }

    // 4. ALTER COLUMN TYPE on critical tables
    const alterTypeMatch = line.match(
      new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?(?:"?)(${criticalTablesRe})(?:"?)\\s+.*ALTER\\s+COLUMN\\s+.*TYPE`, 'i')
    );
    if (alterTypeMatch) {
      issues.push({
        severity: 'WARNING',
        message: `ALTER COLUMN TYPE on critical table '${alterTypeMatch[1]}' in ${filePath}:${lineNum}`,
        file: filePath,
        line: lineNum,
      });
    }

    // 5. ADD COLUMN NOT NULL without DEFAULT
    if (/ADD\s+COLUMN/i.test(upper) && /NOT\s+NULL/i.test(upper) && !/DEFAULT/i.test(upper)) {
      issues.push({
        severity: 'BLOCKER',
        message: `ADD COLUMN with NOT NULL but no DEFAULT in ${filePath}:${lineNum}`,
        file: filePath,
        line: lineNum,
      });
    }

    // 6. ALTER TABLE without IF EXISTS on unknown (non-critical) tables
    const alterTableMatch = line.match(
      /ALTER\s+TABLE\s+(?!IF\s+EXISTS)(?:public\.)?(?:"?)(\w+)(?:"?)/i
    );
    if (alterTableMatch) {
      const tableName = alterTableMatch[1].toLowerCase();
      if (!CRITICAL_TABLES.includes(tableName)) {
        issues.push({
          severity: 'WARNING',
          message: `ALTER TABLE without IF EXISTS on table '${tableName}' in ${filePath}:${lineNum}`,
          file: filePath,
          line: lineNum,
        });
      }
    }

    // 7. DROP INDEX on financial tables
    const dropIndexMatch = line.match(
      new RegExp(`DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?(?:CONCURRENTLY\\s+)?(?:public\\.)?(?:"?)(\\w+)(?:"?)`, 'i')
    );
    if (dropIndexMatch && new RegExp(`(?:${financialTablesRe})`, 'i').test(line)) {
      issues.push({
        severity: 'WARNING',
        message: `DROP INDEX on financial table in ${filePath}:${lineNum}`,
        file: filePath,
        line: lineNum,
      });
    }

    // 8. TRUNCATE
    if (/\bTRUNCATE\b/i.test(trimmed)) {
      issues.push({
        severity: 'BLOCKER',
        message: `TRUNCATE statement in ${filePath}:${lineNum}`,
        file: filePath,
        line: lineNum,
      });
    }

    // 9. DELETE FROM without WHERE
    if (/DELETE\s+FROM/i.test(trimmed) && !/WHERE/i.test(trimmed)) {
      issues.push({
        severity: 'WARNING',
        message: `DELETE FROM without WHERE clause in ${filePath}:${lineNum}`,
        file: filePath,
        line: lineNum,
      });
    }
  }

  return issues;
}

/**
 * Aggregate issues from multiple files into a single SafetyResult.
 */
export function aggregateResults(
  migrationFiles: string[],
  allIssues: SafetyIssue[]
): SafetyResult {
  const blockers = allIssues
    .filter((i) => i.severity === 'BLOCKER')
    .map((i) => i.message);
  const warnings = allIssues
    .filter((i) => i.severity === 'WARNING')
    .map((i) => i.message);

  const affectedTables = new Set<string>();
  const affectedTriggers = new Set<string>();

  for (const issue of allIssues) {
    for (const table of CRITICAL_TABLES) {
      if (issue.message.toLowerCase().includes(`'${table}'`)) {
        affectedTables.add(table);
      }
    }
    for (const trigger of CRITICAL_TRIGGERS) {
      if (issue.message.toLowerCase().includes(`'${trigger}'`)) {
        affectedTriggers.add(trigger);
      }
    }
  }

  return {
    safe: blockers.length === 0,
    migrationFiles,
    blockers,
    warnings,
    affectedTables: [...affectedTables],
    affectedTriggers: [...affectedTriggers],
  };
}

/**
 * Resolve migration file paths from CLI args and CHANGED_FILES env var.
 */
export function resolveMigrationFiles(
  argv: string[],
  changedFilesEnv?: string
): string[] {
  const files: string[] = [];

  // CLI args (skip node and script path)
  const cliArgs = argv.slice(2);
  for (const arg of cliArgs) {
if (arg.match(/(?:^|[/\\])migrations\/.*\.sql$/i) || arg.match(/database\/migrations\/.*\.sql$/i)) {
        files.push(arg);
      }
  }

  // CHANGED_FILES env var
  if (changedFilesEnv) {
    const envFiles = changedFilesEnv
      .split(/[\s,]+/)
      .filter((f) => f.match(/(?:^|[/\\])migrations\/.*\.sql$/i) || f.match(/database\/migrations\/.*\.sql$/i));
    for (const f of envFiles) {
      if (!files.includes(f)) {
        files.push(f);
      }
    }
  }

  // If CLI args were given but none matched migrations, use all args
  if (files.length === 0 && cliArgs.length > 0) {
    for (const arg of cliArgs) {
      if (arg.endsWith('.sql')) {
        files.push(arg);
      }
    }
  }

  return files;
}

// ============================================================================
// CLI
// ============================================================================

function main() {
  const migrationFiles = resolveMigrationFiles(
    process.argv,
    process.env.CHANGED_FILES
  );

  if (migrationFiles.length === 0) {
    const result: SafetyResult = {
      safe: true,
      migrationFiles: [],
      blockers: [],
      warnings: [],
      affectedTables: [],
      affectedTriggers: [],
    };
    console.log(JSON.stringify(result, null, 2));
    writeGitHubOutput(true);
    process.exit(0);
  }

  const allIssues: SafetyIssue[] = [];

  for (const filePath of migrationFiles) {
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      continue;
    }
    const sql = readFileSync(filePath, 'utf-8');
    const issues = analyzeMigrationFile(filePath, sql);
    allIssues.push(...issues);
  }

  const result = aggregateResults(migrationFiles, allIssues);
  console.log(JSON.stringify(result, null, 2));

  writeGitHubOutput(result.safe);

  if (!result.safe) {
    process.exit(1);
  }
}

function writeGitHubOutput(safe: boolean) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `safe=${safe}\n`);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
