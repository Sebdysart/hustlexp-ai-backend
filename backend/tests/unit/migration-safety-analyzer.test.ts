/**
 * Migration Safety Analyzer Unit Tests
 *
 * Tests the regex-based SQL analysis functions that detect dangerous
 * migration patterns before they can merge.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeMigrationFile,
  aggregateResults,
  resolveMigrationFiles,
  CRITICAL_TABLES,
  CRITICAL_TRIGGERS,
  type SafetyIssue,
} from '../../../scripts/analyze-migration-safety.js';

describe('analyzeMigrationFile', () => {
  it('should return no issues for a safe CREATE TABLE migration', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS new_feature (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `;
    const issues = analyzeMigrationFile('migrations/001_safe.sql', sql);
    const blockers = issues.filter((i) => i.severity === 'BLOCKER');
    expect(blockers).toHaveLength(0);
  });

  it('should detect DROP TABLE on critical table as BLOCKER', () => {
    const sql = `DROP TABLE escrows;`;
    const issues = analyzeMigrationFile('migrations/002_drop.sql', sql);
    expect(issues.some((i) => i.severity === 'BLOCKER' && i.message.includes("'escrows'"))).toBe(true);
  });

  it('should detect DROP TABLE IF EXISTS on critical table as BLOCKER', () => {
    const sql = `DROP TABLE IF EXISTS users;`;
    const issues = analyzeMigrationFile('migrations/003_drop.sql', sql);
    expect(issues.some((i) => i.severity === 'BLOCKER' && i.message.includes("'users'"))).toBe(true);
  });

  it('should detect DROP COLUMN on critical table as BLOCKER', () => {
    const sql = `ALTER TABLE tasks DROP COLUMN description;`;
    const issues = analyzeMigrationFile('migrations/004_drop_col.sql', sql);
    expect(issues.some((i) => i.severity === 'BLOCKER' && i.message.includes('DROP COLUMN'))).toBe(true);
  });

  it('should detect DROP TRIGGER on financial invariant trigger as BLOCKER', () => {
    const sql = `DROP TRIGGER IF EXISTS xp_requires_released_escrow ON escrows;`;
    const issues = analyzeMigrationFile('migrations/005_drop_trigger.sql', sql);
    expect(issues.some((i) => i.severity === 'BLOCKER' && i.message.includes("'xp_requires_released_escrow'"))).toBe(true);
  });

  it('should detect all 5 critical triggers as BLOCKER when dropped', () => {
    for (const trigger of CRITICAL_TRIGGERS) {
      const sql = `DROP TRIGGER ${trigger} ON some_table;`;
      const issues = analyzeMigrationFile('migrations/trigger.sql', sql);
      expect(
        issues.some((i) => i.severity === 'BLOCKER' && i.message.includes(`'${trigger}'`)),
        `Expected BLOCKER for dropping trigger ${trigger}`
      ).toBe(true);
    }
  });

  it('should detect ALTER COLUMN TYPE on critical table as WARNING', () => {
    const sql = `ALTER TABLE escrows ALTER COLUMN amount TYPE NUMERIC(20,2);`;
    const issues = analyzeMigrationFile('migrations/006_alter_type.sql', sql);
    expect(issues.some((i) => i.severity === 'WARNING' && i.message.includes('ALTER COLUMN TYPE'))).toBe(true);
  });

  it('should NOT warn about ALTER COLUMN TYPE on non-critical table', () => {
    const sql = `ALTER TABLE IF EXISTS some_random_table ALTER COLUMN foo TYPE TEXT;`;
    const issues = analyzeMigrationFile('migrations/007_alter_safe.sql', sql);
    const typeWarnings = issues.filter((i) => i.message.includes('ALTER COLUMN TYPE'));
    expect(typeWarnings).toHaveLength(0);
  });

  it('should detect ADD COLUMN NOT NULL without DEFAULT as BLOCKER', () => {
    const sql = `ALTER TABLE IF EXISTS users ADD COLUMN email_verified BOOLEAN NOT NULL;`;
    const issues = analyzeMigrationFile('migrations/008_not_null.sql', sql);
    expect(issues.some((i) => i.severity === 'BLOCKER' && i.message.includes('NOT NULL'))).toBe(true);
  });

  it('should allow ADD COLUMN NOT NULL with DEFAULT', () => {
    const sql = `ALTER TABLE IF EXISTS users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;`;
    const issues = analyzeMigrationFile('migrations/009_with_default.sql', sql);
    const notNullBlockers = issues.filter((i) => i.severity === 'BLOCKER' && i.message.includes('NOT NULL'));
    expect(notNullBlockers).toHaveLength(0);
  });

  it('should detect TRUNCATE as BLOCKER', () => {
    const sql = `TRUNCATE TABLE some_table;`;
    const issues = analyzeMigrationFile('migrations/010_truncate.sql', sql);
    expect(issues.some((i) => i.severity === 'BLOCKER' && i.message.includes('TRUNCATE'))).toBe(true);
  });

  it('should detect DELETE FROM without WHERE as WARNING', () => {
    const sql = `DELETE FROM old_records;`;
    const issues = analyzeMigrationFile('migrations/011_delete.sql', sql);
    expect(issues.some((i) => i.severity === 'WARNING' && i.message.includes('DELETE FROM without WHERE'))).toBe(true);
  });

  it('should NOT flag DELETE FROM with WHERE', () => {
    const sql = `DELETE FROM old_records WHERE created_at < '2024-01-01';`;
    const issues = analyzeMigrationFile('migrations/012_delete_where.sql', sql);
    const deleteWarnings = issues.filter((i) => i.message.includes('DELETE FROM without WHERE'));
    expect(deleteWarnings).toHaveLength(0);
  });

  it('should capture multiple issues in one file', () => {
    const sql = `
      DROP TABLE users;
      TRUNCATE TABLE logs;
      ALTER TABLE escrows ALTER COLUMN amount TYPE BIGINT;
      DELETE FROM audit_log;
    `;
    const issues = analyzeMigrationFile('migrations/013_multi.sql', sql);
    const blockers = issues.filter((i) => i.severity === 'BLOCKER');
    const warnings = issues.filter((i) => i.severity === 'WARNING');
    expect(blockers.length).toBeGreaterThanOrEqual(2); // DROP TABLE + TRUNCATE
    expect(warnings.length).toBeGreaterThanOrEqual(1); // DELETE without WHERE or ALTER TYPE
  });

  it('should ignore SQL comments', () => {
    const sql = `
      -- DROP TABLE users;
      -- TRUNCATE TABLE escrows;
      CREATE TABLE IF NOT EXISTS safe_table (id INT);
    `;
    const issues = analyzeMigrationFile('migrations/014_comments.sql', sql);
    const blockers = issues.filter((i) => i.severity === 'BLOCKER');
    expect(blockers).toHaveLength(0);
  });

  it('should include correct line numbers', () => {
    const sql = `-- line 1
-- line 2
DROP TABLE escrows;`;
    const issues = analyzeMigrationFile('migrations/015_lines.sql', sql);
    const dropIssue = issues.find((i) => i.message.includes("'escrows'"));
    expect(dropIssue).toBeDefined();
    expect(dropIssue!.line).toBe(3);
  });

  it('should detect ALTER TABLE without IF EXISTS on unknown tables as WARNING', () => {
    const sql = `ALTER TABLE some_new_table ADD COLUMN foo TEXT;`;
    const issues = analyzeMigrationFile('migrations/016_alter_no_if.sql', sql);
    expect(issues.some((i) => i.severity === 'WARNING' && i.message.includes('without IF EXISTS'))).toBe(true);
  });
});

describe('aggregateResults', () => {
  it('should return safe=true when no issues', () => {
    const result = aggregateResults(['migrations/safe.sql'], []);
    expect(result.safe).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('should return safe=false when there are blockers', () => {
    const issues: SafetyIssue[] = [
      {
        severity: 'BLOCKER',
        message: "DROP TABLE on critical table 'escrows' in migrations/bad.sql:1",
        file: 'migrations/bad.sql',
        line: 1,
      },
    ];
    const result = aggregateResults(['migrations/bad.sql'], issues);
    expect(result.safe).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.affectedTables).toContain('escrows');
  });

  it('should return safe=true when only warnings (no blockers)', () => {
    const issues: SafetyIssue[] = [
      {
        severity: 'WARNING',
        message: "ALTER COLUMN TYPE on critical table 'payments' in migrations/warn.sql:5",
        file: 'migrations/warn.sql',
        line: 5,
      },
    ];
    const result = aggregateResults(['migrations/warn.sql'], issues);
    expect(result.safe).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.affectedTables).toContain('payments');
  });

  it('should track affected triggers', () => {
    const issues: SafetyIssue[] = [
      {
        severity: 'BLOCKER',
        message: "DROP TRIGGER on financial invariant trigger 'task_terminal_guard' in migrations/t.sql:1",
        file: 'migrations/t.sql',
        line: 1,
      },
    ];
    const result = aggregateResults(['migrations/t.sql'], issues);
    expect(result.affectedTriggers).toContain('task_terminal_guard');
  });

  it('should return safe=true with empty inputs', () => {
    const result = aggregateResults([], []);
    expect(result.safe).toBe(true);
    expect(result.migrationFiles).toHaveLength(0);
  });
});

describe('resolveMigrationFiles', () => {
  it('should extract migration files from CLI args', () => {
    const files = resolveMigrationFiles([
      'node',
      'script.ts',
      'migrations/001_foo.sql',
      'migrations/002_bar.sql',
    ]);
    expect(files).toEqual(['migrations/001_foo.sql', 'migrations/002_bar.sql']);
  });

  it('should extract migration files from CHANGED_FILES env var', () => {
    const files = resolveMigrationFiles(
      ['node', 'script.ts'],
      'migrations/001_foo.sql backend/src/foo.ts migrations/002_bar.sql'
    );
    expect(files).toEqual(['migrations/001_foo.sql', 'migrations/002_bar.sql']);
  });

  it('should deduplicate files from CLI args and env', () => {
    const files = resolveMigrationFiles(
      ['node', 'script.ts', 'migrations/001_foo.sql'],
      'migrations/001_foo.sql migrations/002_bar.sql'
    );
    expect(files).toHaveLength(2);
    expect(files).toContain('migrations/001_foo.sql');
    expect(files).toContain('migrations/002_bar.sql');
  });

  it('should return empty array when no migration files', () => {
    const files = resolveMigrationFiles(
      ['node', 'script.ts'],
      'backend/src/foo.ts package.json'
    );
    expect(files).toHaveLength(0);
  });
});
