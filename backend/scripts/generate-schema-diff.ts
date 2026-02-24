/**
 * Schema Diff Generator v1.0.0
 *
 * Produces human-readable diff for database schema changes.
 * Extracts: new columns, removed columns, type changes, new indexes, trigger modifications.
 *
 * @see .github/workflows/orchestrator.yml (migration-safety job)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface SchemaDiff {
  newTables: string[];
  droppedTables: string[];
  newColumns: Array<{ table: string; column: string; type: string }>;
  droppedColumns: Array<{ table: string; column: string }>;
  modifiedColumns: Array<{ table: string; column: string; change: string }>;
  newIndexes: Array<{ table: string; index: string }>;
  droppedIndexes: Array<{ table: string; index: string }>;
  newTriggers: Array<{ table: string; trigger: string }>;
  droppedTriggers: Array<{ table: string; trigger: string }>;
}

/**
 * Get changed migration files
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
 * Parse migration file and extract schema changes
 */
function parseMigrationFile(filepath: string): SchemaDiff {
  const diff: SchemaDiff = {
    newTables: [],
    droppedTables: [],
    newColumns: [],
    droppedColumns: [],
    modifiedColumns: [],
    newIndexes: [],
    droppedIndexes: [],
    newTriggers: [],
    droppedTriggers: [],
  };

  if (!fs.existsSync(filepath)) {
    return diff;
  }

  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line) => {
    const normalized = line.trim().toUpperCase();

    // CREATE TABLE
    if (normalized.startsWith('CREATE TABLE')) {
      const match = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
      if (match) {
        diff.newTables.push(match[1]);
      }
    }

    // DROP TABLE
    if (normalized.startsWith('DROP TABLE')) {
      const match = line.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
      if (match) {
        diff.droppedTables.push(match[1]);
      }
    }

    // ADD COLUMN
    if (normalized.includes('ADD COLUMN')) {
      const match = line.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+(\w+[\w\s()]*)/i);
      if (match) {
        diff.newColumns.push({
          table: match[1],
          column: match[2],
          type: match[3].trim(),
        });
      }
    }

    // DROP COLUMN
    if (normalized.includes('DROP COLUMN')) {
      const match = line.match(/ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
      if (match) {
        diff.droppedColumns.push({
          table: match[1],
          column: match[2],
        });
      }
    }

    // ALTER COLUMN TYPE
    if (normalized.includes('ALTER COLUMN') && normalized.includes('TYPE')) {
      const match = line.match(/ALTER\s+TABLE\s+(\w+)\s+ALTER\s+COLUMN\s+(\w+)\s+TYPE\s+(\w+[\w\s()]*)/i);
      if (match) {
        diff.modifiedColumns.push({
          table: match[1],
          column: match[2],
          change: `Type changed to ${match[3].trim()}`,
        });
      }
    }

    // CREATE INDEX
    if (normalized.startsWith('CREATE INDEX') || normalized.startsWith('CREATE UNIQUE INDEX')) {
      const match = line.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)/i);
      if (match) {
        diff.newIndexes.push({
          index: match[1],
          table: match[2],
        });
      }
    }

    // DROP INDEX
    if (normalized.startsWith('DROP INDEX')) {
      const match = line.match(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
      if (match) {
        diff.droppedIndexes.push({
          index: match[1],
          table: 'unknown',
        });
      }
    }

    // CREATE TRIGGER
    if (normalized.startsWith('CREATE TRIGGER') || normalized.includes('CREATE OR REPLACE')) {
      const match = line.match(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)/i);
      if (match) {
        // Try to extract table from BEFORE/AFTER ... ON table_name
        const tableMatch = content.match(new RegExp(`${match[1]}[\\s\\S]*?ON\\s+(\\w+)`, 'i'));
        diff.newTriggers.push({
          trigger: match[1],
          table: tableMatch ? tableMatch[1] : 'unknown',
        });
      }
    }

    // DROP TRIGGER
    if (normalized.startsWith('DROP TRIGGER')) {
      const match = line.match(/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
      if (match) {
        diff.droppedTriggers.push({
          trigger: match[1],
          table: 'unknown',
        });
      }
    }
  });

  return diff;
}

/**
 * Generate human-readable diff summary
 */
export function generateSchemaDiff(migrationFiles?: string[]): SchemaDiff {
  const files = migrationFiles || getChangedMigrations();

  if (files.length === 0) {
    return {
      newTables: [],
      droppedTables: [],
      newColumns: [],
      droppedColumns: [],
      modifiedColumns: [],
      newIndexes: [],
      droppedIndexes: [],
      newTriggers: [],
      droppedTriggers: [],
    };
  }

  // Parse each file and merge results
  const diffs = files.map(f => {
    const fullPath = path.resolve(process.cwd(), f);
    return parseMigrationFile(fullPath);
  });

  const merged: SchemaDiff = {
    newTables: diffs.flatMap(d => d.newTables),
    droppedTables: diffs.flatMap(d => d.droppedTables),
    newColumns: diffs.flatMap(d => d.newColumns),
    droppedColumns: diffs.flatMap(d => d.droppedColumns),
    modifiedColumns: diffs.flatMap(d => d.modifiedColumns),
    newIndexes: diffs.flatMap(d => d.newIndexes),
    droppedIndexes: diffs.flatMap(d => d.droppedIndexes),
    newTriggers: diffs.flatMap(d => d.newTriggers),
    droppedTriggers: diffs.flatMap(d => d.droppedTriggers),
  };

  return merged;
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const result = generateSchemaDiff();

  console.log('===== DATABASE SCHEMA CHANGES =====\n');

  let hasChanges = false;

  if (result.newTables.length > 0) {
    console.log('✨ New Tables:');
    result.newTables.forEach(t => console.log(`   + ${t}`));
    console.log();
    hasChanges = true;
  }

  if (result.droppedTables.length > 0) {
    console.log('🗑️  Dropped Tables:');
    result.droppedTables.forEach(t => console.log(`   - ${t}`));
    console.log();
    hasChanges = true;
  }

  if (result.newColumns.length > 0) {
    console.log('➕ New Columns:');
    result.newColumns.forEach(c => console.log(`   + ${c.table}.${c.column} (${c.type})`));
    console.log();
    hasChanges = true;
  }

  if (result.droppedColumns.length > 0) {
    console.log('➖ Dropped Columns:');
    result.droppedColumns.forEach(c => console.log(`   - ${c.table}.${c.column}`));
    console.log();
    hasChanges = true;
  }

  if (result.modifiedColumns.length > 0) {
    console.log('🔄 Modified Columns:');
    result.modifiedColumns.forEach(c => console.log(`   ~ ${c.table}.${c.column}: ${c.change}`));
    console.log();
    hasChanges = true;
  }

  if (result.newIndexes.length > 0) {
    console.log('🔍 New Indexes:');
    result.newIndexes.forEach(i => console.log(`   + ${i.index} on ${i.table}`));
    console.log();
    hasChanges = true;
  }

  if (result.droppedIndexes.length > 0) {
    console.log('🗑️  Dropped Indexes:');
    result.droppedIndexes.forEach(i => console.log(`   - ${i.index}`));
    console.log();
    hasChanges = true;
  }

  if (result.newTriggers.length > 0) {
    console.log('⚡ New Triggers:');
    result.newTriggers.forEach(t => console.log(`   + ${t.trigger} on ${t.table}`));
    console.log();
    hasChanges = true;
  }

  if (result.droppedTriggers.length > 0) {
    console.log('🗑️  Dropped Triggers:');
    result.droppedTriggers.forEach(t => console.log(`   - ${t.trigger}`));
    console.log();
    hasChanges = true;
  }

  if (!hasChanges) {
    console.log('No schema changes detected in migration files.\n');
  }

  // Save as JSON for artifact
  const reportPath = `schema-diff-${Date.now()}.json`;
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
  console.log(`Schema diff saved to: ${reportPath}`);
}
