/**
 * Migration Safety Analyzer v1.0.0
 *
 * Parses migration SQL for dangerous patterns that could:
 * - Break financial invariants (DROP TRIGGER on escrow/xp triggers)
 * - Cause data loss (DROP TABLE/COLUMN on critical tables)
 * - Lock production tables (ALTER without CONCURRENTLY)
 * - Break existing rows (NOT NULL without DEFAULT)
 *
 * @see .github/workflows/orchestrator.yml (migration-safety job)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface SafetyAnalysis {
  safe: boolean;
  warnings: string[];
  blockers: string[];
  affectedTables: string[];
  affectedTriggers: string[];
  migrationFiles: string[];
}

// Critical tables that require extra scrutiny
const CRITICAL_TABLES = [
  'users',
  'tasks',
  'escrows',
  'ledger_entries',
  'payments',
  'payment_intents',
  'xp_events',
  'trust_scores',
];

// Financial invariant triggers that must never be dropped
const PROTECTED_TRIGGERS = [
  'xp_requires_released_escrow',
  'escrow_prevents_negative_balance',
  'ledger_double_entry_validation',
  'payment_matches_escrow',
  'trust_score_bounds',
];

/**
 * Get changed migration files from PR
 */
function getChangedMigrations(): string[] {
  try {
    const baseBranch = process.env.GITHUB_BASE_REF || 'main';
    const headBranch = process.env.GITHUB_HEAD_REF || 'HEAD';

    const diffCommand = process.env.CI
      ? `git diff --name-only origin/${baseBranch}...${headBranch}`
      : `git diff --name-only main...HEAD`;

    const output = execSync(diffCommand, { encoding: 'utf-8' });
    const files = output.trim().split('\n').filter(Boolean);

    return files.filter(f => f.startsWith('migrations/') && f.endsWith('.sql'));
  } catch (error) {
    console.error('Failed to get changed migrations:', error);
    return [];
  }
}

/**
 * Analyze a single migration file
 */
function analyzeMigrationFile(filepath: string): SafetyAnalysis {
  const analysis: SafetyAnalysis = {
    safe: true,
    warnings: [],
    blockers: [],
    affectedTables: [],
    affectedTriggers: [],
    migrationFiles: [filepath],
  };

  if (!fs.existsSync(filepath)) {
    analysis.blockers.push(`Migration file not found: ${filepath}`);
    analysis.safe = false;
    return analysis;
  }

  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n');

  // Check for dangerous patterns line by line
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const normalizedLine = line.trim().toUpperCase();

    // Pattern 1: DROP TABLE on critical tables
    if (normalizedLine.startsWith('DROP TABLE')) {
      const tableMatch = line.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
      if (tableMatch) {
        const table = tableMatch[1];
        analysis.affectedTables.push(table);

        if (CRITICAL_TABLES.includes(table.toLowerCase())) {
          analysis.blockers.push(
            `Line ${lineNum}: DROP TABLE ${table} — This is a critical financial table and cannot be dropped`
          );
          analysis.safe = false;
        } else {
          analysis.warnings.push(
            `Line ${lineNum}: DROP TABLE ${table} — Ensure backups exist and no code references this table`
          );
        }
      }
    }

    // Pattern 2: DROP COLUMN on critical tables
    if (normalizedLine.includes('DROP COLUMN')) {
      const match = line.match(/ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(\w+)/i);
      if (match) {
        const [, table, column] = match;
        analysis.affectedTables.push(table);

        if (CRITICAL_TABLES.includes(table.toLowerCase())) {
          analysis.blockers.push(
            `Line ${lineNum}: DROP COLUMN ${table}.${column} — Use expand-contract pattern: mark as nullable first, remove references, then drop in future migration`
          );
          analysis.safe = false;
        } else {
          analysis.warnings.push(
            `Line ${lineNum}: DROP COLUMN ${table}.${column} — Verify no code references this column`
          );
        }
      }
    }

    // Pattern 3: DROP TRIGGER on protected triggers
    if (normalizedLine.startsWith('DROP TRIGGER')) {
      const match = line.match(/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
      if (match) {
        const trigger = match[1];
        analysis.affectedTriggers.push(trigger);

        if (PROTECTED_TRIGGERS.includes(trigger.toLowerCase())) {
          analysis.blockers.push(
            `Line ${lineNum}: DROP TRIGGER ${trigger} — This trigger enforces a financial invariant (INV-${PROTECTED_TRIGGERS.indexOf(trigger.toLowerCase()) + 1}) and cannot be removed`
          );
          analysis.safe = false;
        } else {
          analysis.warnings.push(
            `Line ${lineNum}: DROP TRIGGER ${trigger} — Verify this doesn't break business logic`
          );
        }
      }
    }

    // Pattern 4: ADD COLUMN NOT NULL without DEFAULT
    if (normalizedLine.includes('ADD COLUMN') && normalizedLine.includes('NOT NULL')) {
      if (!normalizedLine.includes('DEFAULT')) {
        const match = line.match(/ADD\s+COLUMN\s+(\w+)/i);
        const column = match ? match[1] : 'unknown';

        analysis.blockers.push(
          `Line ${lineNum}: ADD COLUMN ${column} NOT NULL without DEFAULT — This will fail if table has existing rows. Add DEFAULT or backfill in separate migration.`
        );
        analysis.safe = false;
      }
    }

    // Pattern 5: ALTER COLUMN TYPE without USING or CONCURRENTLY
    if (normalizedLine.includes('ALTER COLUMN') && normalizedLine.includes('TYPE')) {
      const match = line.match(/ALTER\s+TABLE\s+(\w+)/i);
      const table = match ? match[1] : 'unknown';

      if (
        CRITICAL_TABLES.includes(table.toLowerCase()) &&
        !normalizedLine.includes('USING') &&
        !normalizedLine.includes('CONCURRENTLY')
      ) {
        analysis.warnings.push(
          `Line ${lineNum}: ALTER COLUMN TYPE on ${table} — Consider using USING clause for data transformation or run during maintenance window (locks table)`
        );
      }
    }

    // Pattern 6: Missing IF EXISTS/IF NOT EXISTS guards
    if (
      (normalizedLine.startsWith('CREATE TABLE') ||
        normalizedLine.startsWith('CREATE INDEX') ||
        normalizedLine.startsWith('CREATE TRIGGER')) &&
      !normalizedLine.includes('IF NOT EXISTS')
    ) {
      analysis.warnings.push(
        `Line ${lineNum}: Missing IF NOT EXISTS guard — Migration may fail if run twice (not idempotent)`
      );
    }

    if (
      (normalizedLine.startsWith('DROP TABLE') ||
        normalizedLine.startsWith('DROP INDEX') ||
        normalizedLine.startsWith('DROP TRIGGER')) &&
      !normalizedLine.includes('IF EXISTS')
    ) {
      analysis.warnings.push(
        `Line ${lineNum}: Missing IF EXISTS guard — Migration may fail if object doesn't exist`
      );
    }

    // Pattern 7: Detect affected tables from ALTER TABLE statements
    if (normalizedLine.startsWith('ALTER TABLE')) {
      const match = line.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
      if (match && !analysis.affectedTables.includes(match[1])) {
        analysis.affectedTables.push(match[1]);
      }
    }
  });

  return analysis;
}

/**
 * Analyze all changed migrations and produce summary
 */
export function analyzeMigrations(migrationFiles?: string[]): SafetyAnalysis {
  const files = migrationFiles || getChangedMigrations();

  if (files.length === 0) {
    return {
      safe: true,
      warnings: [],
      blockers: [],
      affectedTables: [],
      affectedTriggers: [],
      migrationFiles: [],
    };
  }

  // Analyze each file
  const analyses = files.map(f => {
    const fullPath = path.resolve(process.cwd(), f);
    return analyzeMigrationFile(fullPath);
  });

  // Merge results
  const merged: SafetyAnalysis = {
    safe: analyses.every(a => a.safe),
    warnings: analyses.flatMap(a => a.warnings),
    blockers: analyses.flatMap(a => a.blockers),
    affectedTables: [...new Set(analyses.flatMap(a => a.affectedTables))],
    affectedTriggers: [...new Set(analyses.flatMap(a => a.affectedTriggers))],
    migrationFiles: files,
  };

  return merged;
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const result = analyzeMigrations();

  console.log('===== MIGRATION SAFETY ANALYSIS =====\n');

  if (result.migrationFiles.length === 0) {
    console.log('No migration files found in this PR');
    process.exit(0);
  }

  console.log(`Analyzed ${result.migrationFiles.length} migration file(s):\n`);
  result.migrationFiles.forEach(f => console.log(`  - ${f}`));
  console.log();

  if (result.affectedTables.length > 0) {
    console.log('Affected Tables:');
    result.affectedTables.forEach(t => console.log(`  • ${t}`));
    console.log();
  }

  if (result.affectedTriggers.length > 0) {
    console.log('Affected Triggers:');
    result.affectedTriggers.forEach(t => console.log(`  • ${t}`));
    console.log();
  }

  if (result.blockers.length > 0) {
    console.log('🚨 BLOCKERS (must fix before merge):\n');
    result.blockers.forEach(b => console.log(`  ❌ ${b}`));
    console.log();
  }

  if (result.warnings.length > 0) {
    console.log('⚠️  WARNINGS (review carefully):\n');
    result.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
    console.log();
  }

  if (result.safe) {
    console.log('✅ Migration safety: PASSED');
    console.log('   No blocking issues detected. Review warnings above.\n');
  } else {
    console.log('❌ Migration safety: FAILED');
    console.log(`   ${result.blockers.length} blocking issue(s) must be fixed.\n`);
  }

  // Write JSON report for artifact
  const reportPath = `migration-safety-${Date.now()}.json`;
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
  console.log(`Report saved to: ${reportPath}`);

  // Exit code
  process.exit(result.safe ? 0 : 1);
}
