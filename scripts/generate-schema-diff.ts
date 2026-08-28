#!/usr/bin/env tsx
/**
 * Schema Diff Generator
 *
 * Reads migration SQL files changed in a PR and produces a human-readable
 * markdown summary of schema changes for inclusion in readiness score comments.
 *
 * Usage:
 *   npx tsx scripts/generate-schema-diff.ts backend/database/migrations/20260222_008_foo.sql
 *   CHANGED_FILES="backend/database/migrations/foo.sql" npx tsx scripts/generate-schema-diff.ts
 */

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import { resolveMigrationFiles } from './analyze-migration-safety.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SchemaDiff {
  tablesCreated: string[];
  tablesModified: string[];
  tablesDropped: string[];
  columnsAdded: { table: string; column: string }[];
  columnsDropped: { table: string; column: string }[];
  columnsRenamed: { table: string; from: string; to: string }[];
  columnsTypeChanged: { table: string; column: string }[];
  indexesAdded: string[];
  indexesDropped: string[];
  triggersAdded: string[];
  triggersDropped: string[];
  extensionsEnabled: string[];
}

// ============================================================================
// PARSING
// ============================================================================

/**
 * Parse a single migration SQL file and extract schema changes.
 */
export function parseSchemaDiff(sql: string): SchemaDiff {
  const diff: SchemaDiff = {
    tablesCreated: [],
    tablesModified: [],
    tablesDropped: [],
    columnsAdded: [],
    columnsDropped: [],
    columnsRenamed: [],
    columnsTypeChanged: [],
    indexesAdded: [],
    indexesDropped: [],
    triggersAdded: [],
    triggersDropped: [],
    extensionsEnabled: [],
  };

  const lines = sql.split('\n');
  let currentAlterTable: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;

    // CREATE TABLE
    const createTableMatch = trimmed.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(?:"?)(\w+)(?:"?)/i
    );
    if (createTableMatch) {
      diff.tablesCreated.push(createTableMatch[1]);
    }

    // DROP TABLE
    const dropTableMatch = trimmed.match(
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(?:"?)(\w+)(?:"?)/i
    );
    if (dropTableMatch) {
      diff.tablesDropped.push(dropTableMatch[1]);
    }

    // ALTER TABLE — track current table
    const alterTableMatch = trimmed.match(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(?:"?)(\w+)(?:"?)/i
    );
    if (alterTableMatch) {
      currentAlterTable = alterTableMatch[1];
      if (!diff.tablesModified.includes(currentAlterTable) && !diff.tablesCreated.includes(currentAlterTable)) {
        diff.tablesModified.push(currentAlterTable);
      }
    }

    // ADD COLUMN
    const addColMatch = trimmed.match(
      /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?)(\w+)(?:"?)/i
    );
    if (addColMatch && currentAlterTable) {
      diff.columnsAdded.push({ table: currentAlterTable, column: addColMatch[1] });
    }

    // DROP COLUMN
    const dropColMatch = trimmed.match(
      /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:"?)(\w+)(?:"?)/i
    );
    if (dropColMatch && currentAlterTable) {
      diff.columnsDropped.push({ table: currentAlterTable, column: dropColMatch[1] });
    }

    // RENAME COLUMN
    const renameColMatch = trimmed.match(
      /RENAME\s+COLUMN\s+(?:"?)(\w+)(?:"?)\s+TO\s+(?:"?)(\w+)(?:"?)/i
    );
    if (renameColMatch && currentAlterTable) {
      diff.columnsRenamed.push({
        table: currentAlterTable,
        from: renameColMatch[1],
        to: renameColMatch[2],
      });
    }

    // ALTER COLUMN TYPE
    const alterTypeMatch = trimmed.match(
      /ALTER\s+COLUMN\s+(?:"?)(\w+)(?:"?)\s+(?:SET\s+DATA\s+)?TYPE/i
    );
    if (alterTypeMatch && currentAlterTable) {
      diff.columnsTypeChanged.push({
        table: currentAlterTable,
        column: alterTypeMatch[1],
      });
    }

    // CREATE INDEX
    const createIndexMatch = trimmed.match(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:CONCURRENTLY\s+)?(?:"?)(\w+)(?:"?)/i
    );
    if (createIndexMatch) {
      diff.indexesAdded.push(createIndexMatch[1]);
    }

    // DROP INDEX
    const dropIndexMatch = trimmed.match(
      /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:CONCURRENTLY\s+)?(?:public\.)?(?:"?)(\w+)(?:"?)/i
    );
    if (dropIndexMatch) {
      diff.indexesDropped.push(dropIndexMatch[1]);
    }

    // CREATE TRIGGER
    const createTriggerMatch = trimmed.match(
      /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:"?)(\w+)(?:"?)/i
    );
    if (createTriggerMatch) {
      diff.triggersAdded.push(createTriggerMatch[1]);
    }

    // DROP TRIGGER
    const dropTriggerMatch = trimmed.match(
      /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(?:"?)(\w+)(?:"?)/i
    );
    if (dropTriggerMatch) {
      diff.triggersDropped.push(dropTriggerMatch[1]);
    }

    // CREATE EXTENSION
    const extMatch = trimmed.match(
      /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?)(\w+)(?:"?)/i
    );
    if (extMatch) {
      diff.extensionsEnabled.push(extMatch[1]);
    }

    // Reset currentAlterTable on semicolons (statement end)
    if (trimmed.endsWith(';')) {
      currentAlterTable = null;
    }
  }

  return diff;
}

/**
 * Merge multiple SchemaDiffs into one.
 */
export function mergeDiffs(diffs: SchemaDiff[]): SchemaDiff {
  const merged: SchemaDiff = {
    tablesCreated: [],
    tablesModified: [],
    tablesDropped: [],
    columnsAdded: [],
    columnsDropped: [],
    columnsRenamed: [],
    columnsTypeChanged: [],
    indexesAdded: [],
    indexesDropped: [],
    triggersAdded: [],
    triggersDropped: [],
    extensionsEnabled: [],
  };

  for (const diff of diffs) {
    merged.tablesCreated.push(...diff.tablesCreated);
    merged.tablesModified.push(...diff.tablesModified);
    merged.tablesDropped.push(...diff.tablesDropped);
    merged.columnsAdded.push(...diff.columnsAdded);
    merged.columnsDropped.push(...diff.columnsDropped);
    merged.columnsRenamed.push(...diff.columnsRenamed);
    merged.columnsTypeChanged.push(...diff.columnsTypeChanged);
    merged.indexesAdded.push(...diff.indexesAdded);
    merged.indexesDropped.push(...diff.indexesDropped);
    merged.triggersAdded.push(...diff.triggersAdded);
    merged.triggersDropped.push(...diff.triggersDropped);
    merged.extensionsEnabled.push(...diff.extensionsEnabled);
  }

  // Deduplicate simple arrays
  merged.tablesCreated = [...new Set(merged.tablesCreated)];
  merged.tablesModified = [...new Set(merged.tablesModified)];
  merged.tablesDropped = [...new Set(merged.tablesDropped)];
  merged.indexesAdded = [...new Set(merged.indexesAdded)];
  merged.indexesDropped = [...new Set(merged.indexesDropped)];
  merged.triggersAdded = [...new Set(merged.triggersAdded)];
  merged.triggersDropped = [...new Set(merged.triggersDropped)];
  merged.extensionsEnabled = [...new Set(merged.extensionsEnabled)];

  return merged;
}

/**
 * Generate a human-readable markdown summary from a SchemaDiff.
 */
export function generateMarkdown(
  diff: SchemaDiff,
  fileNames: string[]
): string {
  const sections: string[] = [];
  sections.push('## Schema Diff Summary');
  sections.push('');
  sections.push(`**Migration files:** ${fileNames.map((f) => `\`${basename(f)}\``).join(', ')}`);
  sections.push('');

  const hasChanges =
    diff.tablesCreated.length > 0 ||
    diff.tablesModified.length > 0 ||
    diff.tablesDropped.length > 0 ||
    diff.columnsAdded.length > 0 ||
    diff.columnsDropped.length > 0 ||
    diff.columnsRenamed.length > 0 ||
    diff.columnsTypeChanged.length > 0 ||
    diff.indexesAdded.length > 0 ||
    diff.indexesDropped.length > 0 ||
    diff.triggersAdded.length > 0 ||
    diff.triggersDropped.length > 0 ||
    diff.extensionsEnabled.length > 0;

  if (!hasChanges) {
    sections.push('No schema changes detected.');
    return sections.join('\n');
  }

  if (diff.tablesCreated.length > 0) {
    sections.push('### Tables Created');
    for (const t of diff.tablesCreated) sections.push(`- \`${t}\``);
    sections.push('');
  }

  if (diff.tablesModified.length > 0) {
    sections.push('### Tables Modified');
    for (const t of diff.tablesModified) sections.push(`- \`${t}\``);
    sections.push('');
  }

  if (diff.tablesDropped.length > 0) {
    sections.push('### Tables Dropped');
    for (const t of diff.tablesDropped) sections.push(`- \`${t}\``);
    sections.push('');
  }

  if (diff.columnsAdded.length > 0) {
    sections.push('### Columns Added');
    for (const c of diff.columnsAdded) sections.push(`- \`${c.table}.${c.column}\``);
    sections.push('');
  }

  if (diff.columnsDropped.length > 0) {
    sections.push('### Columns Dropped');
    for (const c of diff.columnsDropped) sections.push(`- \`${c.table}.${c.column}\``);
    sections.push('');
  }

  if (diff.columnsRenamed.length > 0) {
    sections.push('### Columns Renamed');
    for (const c of diff.columnsRenamed) sections.push(`- \`${c.table}.${c.from}\` -> \`${c.to}\``);
    sections.push('');
  }

  if (diff.columnsTypeChanged.length > 0) {
    sections.push('### Column Type Changes');
    for (const c of diff.columnsTypeChanged) sections.push(`- \`${c.table}.${c.column}\``);
    sections.push('');
  }

  if (diff.indexesAdded.length > 0) {
    sections.push('### Indexes Added');
    for (const idx of diff.indexesAdded) sections.push(`- \`${idx}\``);
    sections.push('');
  }

  if (diff.indexesDropped.length > 0) {
    sections.push('### Indexes Dropped');
    for (const idx of diff.indexesDropped) sections.push(`- \`${idx}\``);
    sections.push('');
  }

  if (diff.triggersAdded.length > 0) {
    sections.push('### Triggers Added');
    for (const t of diff.triggersAdded) sections.push(`- \`${t}\``);
    sections.push('');
  }

  if (diff.triggersDropped.length > 0) {
    sections.push('### Triggers Dropped');
    for (const t of diff.triggersDropped) sections.push(`- \`${t}\``);
    sections.push('');
  }

  if (diff.extensionsEnabled.length > 0) {
    sections.push('### Extensions Enabled');
    for (const e of diff.extensionsEnabled) sections.push(`- \`${e}\``);
    sections.push('');
  }

  return sections.join('\n');
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
    console.log('## Schema Diff Summary\n\nNo migration files changed.');
    process.exit(0);
  }

  const diffs: SchemaDiff[] = [];

  for (const filePath of migrationFiles) {
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      continue;
    }
    const sql = readFileSync(filePath, 'utf-8');
    diffs.push(parseSchemaDiff(sql));
  }

  const merged = mergeDiffs(diffs);
  const markdown = generateMarkdown(merged, migrationFiles);
  console.log(markdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
