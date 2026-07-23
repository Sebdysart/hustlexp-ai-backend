/**
 * Migration Safety Analyzer
 *
 * Regex-based static analysis that flags dangerous SQL migration patterns
 * before they can merge. Designed to run in CI against changed `migrations/*.sql`
 * files (CLI args or the CHANGED_FILES env var).
 *
 * Severity model:
 *   - BLOCKER : must not merge (irreversible / invariant-breaking).
 *   - WARNING : needs human review (potentially destructive but sometimes valid).
 *
 * The financial-invariant triggers below are the PostgreSQL-enforced guards
 * referenced in CLAUDE.md (INV-1 … INV-5). Dropping any of them removes a
 * money-safety guarantee and is always a BLOCKER.
 *
 * Pure functions (analyzeMigrationFile / aggregateResults / resolveMigrationFiles)
 * are exported for unit testing; a thin CLI `main()` runs when executed directly.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type Severity = 'BLOCKER' | 'WARNING';

export interface SafetyIssue {
  severity: Severity;
  message: string;
  file: string;
  line: number;
}

export interface AggregateResult {
  safe: boolean;
  blockers: SafetyIssue[];
  warnings: SafetyIssue[];
  affectedTables: string[];
  affectedTriggers: string[];
  migrationFiles: string[];
}

/**
 * Tables whose structure underpins financial invariants. Destructive changes
 * to these (DROP TABLE / DROP COLUMN) are BLOCKERs; risky changes (ALTER TYPE)
 * are WARNINGs.
 */
export const CRITICAL_TABLES: readonly string[] = [
  'escrows',
  'users',
  'tasks',
  'payments',
  'ledger_entries',
  'disputes',
  'chargebacks',
  'payouts',
  'xp_ledger',
];

/**
 * The five PostgreSQL triggers that enforce the financial invariants
 * (INV-1 … INV-5 in CLAUDE.md). Dropping any is always a BLOCKER.
 */
export const CRITICAL_TRIGGERS: readonly string[] = [
  'escrow_balance_check', // INV-1: escrow amounts positive integer cents
  'xp_requires_released_escrow', // INV-2: XP requires released escrow
  'prevent_double_release', // INV-3: escrow released at most once
  'ledger_entry_immutable', // INV-4: ledger append-only
  'payment_amount_check', // INV-5: payment amounts positive
];

/** Strip a line's `--` comment tail while preserving the line for numbering. */
function stripLineComment(line: string): string {
  const idx = line.indexOf('--');
  return idx === -1 ? line : line.slice(0, idx);
}

function isCriticalTable(name: string): boolean {
  return CRITICAL_TABLES.includes(name.toLowerCase());
}

function isCriticalTrigger(name: string): boolean {
  return CRITICAL_TRIGGERS.includes(name.toLowerCase());
}

/**
 * Analyze a single migration's SQL text and return all safety issues found.
 * Operates line-by-line (after stripping `--` comments) so reported line
 * numbers are accurate.
 */
export function analyzeMigrationFile(file: string, sql: string): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const rawLines = sql.split('\n');

  rawLines.forEach((raw, i) => {
    const line = stripLineComment(raw);
    if (!line.trim()) return;
    const lineNo = i + 1;
    const add = (severity: Severity, message: string) =>
      issues.push({ severity, message: `${message} in ${file}:${lineNo}`, file, line: lineNo });

    // TRUNCATE statements are always destructive. Match only at a statement
    // boundary so protective trigger clauses such as `BEFORE TRUNCATE ON ...`
    // are not misclassified as data-loss operations.
    if (/(?:^|;)\s*TRUNCATE\s+(?:TABLE\s+)?["'`]?\w+/i.test(line)) {
      add('BLOCKER', 'TRUNCATE detected (irreversible data loss)');
    }

    // DROP TABLE [IF EXISTS] <table>
    const dropTable = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i.exec(line);
    if (dropTable) {
      const table = dropTable[1]!;
      if (isCriticalTable(table)) {
        add('BLOCKER', `DROP TABLE on critical table '${table}'`);
      } else {
        add('WARNING', `DROP TABLE on table '${table}'`);
      }
    }

    // DROP TRIGGER [IF EXISTS] <trigger>
    const dropTrigger = /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i.exec(line);
    if (dropTrigger) {
      const trigger = dropTrigger[1]!;
      if (isCriticalTrigger(trigger)) {
        add('BLOCKER', `DROP TRIGGER on financial invariant trigger '${trigger}'`);
      } else {
        add('WARNING', `DROP TRIGGER on trigger '${trigger}'`);
      }
    }

    // ALTER TABLE [IF EXISTS] <table> … (DROP COLUMN | ALTER COLUMN … TYPE)
    const alterTable = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i.exec(line);
    if (alterTable) {
      const table = alterTable[1]!;
      const critical = isCriticalTable(table);

      if (/\bDROP\s+COLUMN\b/i.test(line)) {
        add(
          critical ? 'BLOCKER' : 'WARNING',
          `DROP COLUMN on ${critical ? 'critical ' : ''}table '${table}'`,
        );
      }

      if (/\bALTER\s+COLUMN\s+\w+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(line) && critical) {
        add('WARNING', `ALTER COLUMN TYPE on critical table '${table}'`);
      }

      // ALTER TABLE without IF EXISTS — fragile if the table was renamed/dropped.
      if (!/\bALTER\s+TABLE\s+IF\s+EXISTS\b/i.test(line)) {
        add('WARNING', `ALTER TABLE without IF EXISTS on table '${table}'`);
      }
    }

    // ADD COLUMN … NOT NULL without DEFAULT — locks/rewrites the table and
    // fails on existing rows.
    if (/\bADD\s+COLUMN\b/i.test(line) && /\bNOT\s+NULL\b/i.test(line) && !/\bDEFAULT\b/i.test(line)) {
      add('BLOCKER', 'ADD COLUMN NOT NULL without DEFAULT (fails on existing rows)');
    }

    // DELETE FROM without WHERE — wipes a whole table.
    if (/\bDELETE\s+FROM\s+\w+/i.test(line) && !/\bWHERE\b/i.test(line)) {
      add('WARNING', 'DELETE FROM without WHERE (deletes all rows)');
    }
  });

  return issues;
}

/** Extract a single-quoted identifier from an issue message, if present. */
function quotedName(message: string): string | null {
  const m = /'([^']+)'/.exec(message);
  return m ? m[1]! : null;
}

/**
 * Roll a set of per-file issues up into a verdict. `safe` is false iff any
 * BLOCKER is present. Affected tables/triggers are parsed from issue messages.
 */
export function aggregateResults(migrationFiles: string[], issues: SafetyIssue[]): AggregateResult {
  const blockers = issues.filter((i) => i.severity === 'BLOCKER');
  const warnings = issues.filter((i) => i.severity === 'WARNING');

  const affectedTables = new Set<string>();
  const affectedTriggers = new Set<string>();
  for (const issue of issues) {
    const name = quotedName(issue.message);
    if (!name) continue;
    if (/\btrigger\b/i.test(issue.message)) affectedTriggers.add(name);
    else if (/\btable\b/i.test(issue.message)) affectedTables.add(name);
  }

  return {
    safe: blockers.length === 0,
    blockers,
    warnings,
    affectedTables: [...affectedTables],
    affectedTriggers: [...affectedTriggers],
    migrationFiles,
  };
}

/** True for paths that look like a SQL migration file. */
function isMigrationPath(f: string): boolean {
  return f.includes('migrations/') && f.endsWith('.sql');
}

/**
 * Resolve the list of migration SQL files to analyze from CLI argv and/or the
 * CHANGED_FILES env string (space-separated). Deduplicated, order-preserving.
 */
export function resolveMigrationFiles(argv: string[], changedFiles?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (f: string) => {
    if (isMigrationPath(f) && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  };

  // argv[0]=node, argv[1]=script — the rest are candidate paths.
  for (const arg of argv.slice(2)) push(arg);
  if (changedFiles) {
    for (const f of changedFiles.split(/\s+/).filter(Boolean)) push(f);
  }
  return out;
}

/** CLI entry point: analyze changed migrations, print, exit non-zero on blockers. */
function main(): void {
  const files = resolveMigrationFiles(process.argv, process.env.CHANGED_FILES);
  if (files.length === 0) {
    console.warn('migration-safety: no migration files to analyze');
    return;
  }

  const allIssues: SafetyIssue[] = [];
  for (const file of files) {
    try {
      const sql = readFileSync(file, 'utf-8');
      allIssues.push(...analyzeMigrationFile(file, sql));
    } catch (err) {
      console.error(`migration-safety: could not read ${file}: ${String(err)}`);
      process.exitCode = 1;
    }
  }

  const result = aggregateResults(files, allIssues);
  for (const issue of result.blockers) console.error(`BLOCKER  ${issue.message}`);
  for (const issue of result.warnings) console.warn(`WARNING  ${issue.message}`);

  if (!result.safe) {
    console.error(
      `\nmigration-safety: ${result.blockers.length} blocker(s) found — migration must not merge.`,
    );
    process.exitCode = 1;
  } else {
    console.warn(
      `migration-safety: OK (${result.warnings.length} warning(s)) across ${files.length} file(s).`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
