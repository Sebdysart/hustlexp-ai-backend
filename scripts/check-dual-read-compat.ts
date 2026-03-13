#!/usr/bin/env tsx
/**
 * Dual-Read Compatibility Checker
 *
 * When migration SQL adds/renames/drops columns, checks if application code
 * references those columns. Helps prevent deploying schema changes that break
 * running application code.
 *
 * Usage:
 *   npx tsx scripts/check-dual-read-compat.ts backend/database/migrations/20260222_008_foo.sql
 *   CHANGED_FILES="backend/database/migrations/foo.sql" npx tsx scripts/check-dual-read-compat.ts
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolveMigrationFiles } from './analyze-migration-safety.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ColumnChange {
  column: string;
  operation: 'ADD' | 'DROP' | 'RENAME';
  newName?: string; // for RENAME
  file: string;
  line: number;
}

export interface CompatIssue {
  column: string;
  operation: string;
  referencedIn: string[];
}

export interface CompatResult {
  compatible: boolean;
  issues: CompatIssue[];
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

/**
 * Extract column changes (ADD, DROP, RENAME) from migration SQL.
 */
export function extractColumnChanges(
  filePath: string,
  sql: string
): ColumnChange[] {
  const changes: ColumnChange[] = [];
  const lines = sql.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('--')) continue;

    // ADD COLUMN <name>
    const addMatch = line.match(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?)(\w+)(?:"?)/i);
    if (addMatch) {
      changes.push({
        column: addMatch[1],
        operation: 'ADD',
        file: filePath,
        line: lineNum,
      });
    }

    // DROP COLUMN <name>
    const dropMatch = line.match(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:"?)(\w+)(?:"?)/i);
    if (dropMatch) {
      changes.push({
        column: dropMatch[1],
        operation: 'DROP',
        file: filePath,
        line: lineNum,
      });
    }

    // RENAME COLUMN <old> TO <new>
    const renameMatch = line.match(/RENAME\s+COLUMN\s+(?:"?)(\w+)(?:"?)\s+TO\s+(?:"?)(\w+)(?:"?)/i);
    if (renameMatch) {
      changes.push({
        column: renameMatch[1],
        operation: 'RENAME',
        newName: renameMatch[2],
        file: filePath,
        line: lineNum,
      });
    }
  }

  return changes;
}

/**
 * Search backend source code for references to a column name.
 * Returns file:line references.
 */
export function findColumnReferences(
  columnName: string,
  searchDir: string
): string[] {
  try {
    const result = execSync(
      `grep -rn '\\b${columnName}\\b' "${searchDir}" --include="*.ts" --include="*.js" || true`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );

    if (!result.trim()) return [];

    return result
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        // Format: file:line:content -> file:line
        const parts = line.split(':');
        return `${parts[0]}:${parts[1]}`;
      });
  } catch {
    return [];
  }
}

/**
 * Check compatibility of column changes against application code.
 */
export function checkCompatibility(
  changes: ColumnChange[],
  searchDir: string
): CompatResult {
  const issues: CompatIssue[] = [];

  for (const change of changes) {
    // Only check DROP and RENAME (old name) for breaking references
    if (change.operation === 'DROP' || change.operation === 'RENAME') {
      const refs = findColumnReferences(change.column, searchDir);
      if (refs.length > 0) {
        issues.push({
          column: change.column,
          operation: change.operation,
          referencedIn: refs,
        });
      }
    }
  }

  return {
    compatible: issues.length === 0,
    issues,
  };
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
    const result: CompatResult = { compatible: true, issues: [] };
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  const allChanges: ColumnChange[] = [];

  for (const filePath of migrationFiles) {
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      continue;
    }
    const sql = readFileSync(filePath, 'utf-8');
    const changes = extractColumnChanges(filePath, sql);
    allChanges.push(...changes);
  }

  const searchDir = 'backend/src';
  const result = checkCompatibility(allChanges, searchDir);
  console.log(JSON.stringify(result, null, 2));

  if (!result.compatible) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
