#!/usr/bin/env node
/**
 * Migration Consolidation Script
 * 
 * Purpose: Consolidate migrations from multiple directories into one unified directory.
 * Features:
 *   - Scans source directories for .sql and .ts migration files
 *   - Extracts timestamps from various filename formats
 *   - Deduplicates migrations using SHA256 content hash
 *   - Sorts migrations by timestamp and renames with sequential prefixes
 *   - Generates a registry.json with metadata for all migrations
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface MigrationFile {
  sourcePath: string;
  filename: string;
  content: string;
  timestamp: Date | null;
  hash: string;
}

export interface MigrationEntry {
  filename: string;
  originalFilename: string;
  sourcePath: string;
  hash: string;
  timestamp: string | null;
  sequentialPrefix: string;
}

export interface Registry {
  generatedAt: string;
  totalMigrations: number;
  migrations: MigrationEntry[];
  duplicates: DuplicateEntry[];
}

export interface DuplicateEntry {
  hash: string;
  sources: string[];
}

export interface ConsolidationOptions {
  sourceDirs: string[];
  targetDir: string;
  extensions?: string[];
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_EXTENSIONS = ['.sql', '.ts'];

// Regex patterns for timestamp extraction
const TIMESTAMP_PATTERNS = [
  // YYYYMMDDHHMMSS_name.sql (14 digits)
  { pattern: /^(\d{14})_/, format: 'YYYYMMDDHHMMSS' },
  // YYYYMMDD_name.sql (8 digits)
  { pattern: /^(\d{8})_/, format: 'YYYYMMDD' },
  // YYYY-MM-DD_name.sql or YYYY.MM.DD_name.sql
  { pattern: /^(\d{4})[-.](\d{2})[-.](\d{2})_/, format: 'YYYY-MM-DD' },
  // YYYY-MM-DD-HH-MM-SS_name.sql
  { pattern: /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})_/, format: 'YYYY-MM-DD-HH-MM-SS' },
  // phase12c_name.sql - extract number part
  { pattern: /^phase(\d+)[a-z]?_/, format: 'PHASE' },
  // v1.2.3_name.sql or V1.2.3_name.sql
  { pattern: /^v?(\d+)\.(\d+)\.(\d+)_/, format: 'SEMVER' },
  // 2025_name.sql (4 digits - year only)
  { pattern: /^(\d{4})_/, format: 'YYYY' },
  // migration_YYYYMMDD_name.sql
  { pattern: /migration_(\d{8})_/, format: 'MIGRATION_YYYYMMDD' },
  // Any 6+ digit sequence at start
  { pattern: /^(\d{6,})/, format: 'GENERIC' },
];

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Compute SHA256 hash of content
 */
export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Extract timestamp from filename
 * Supports formats like:
 *   - 20250117_name.sql (YYYYMMDD)
 *   - 2025-name.sql (year)
 *   - phase12c_name.sql (phase number)
 *   - 20250117120000_name.sql (YYYYMMDDHHMMSS)
 */
export function extractTimestamp(filename: string): Date | null {
  const nameWithoutExt = path.basename(filename, path.extname(filename));

  for (const { pattern, format } of TIMESTAMP_PATTERNS) {
    const match = nameWithoutExt.match(pattern);
    if (match) {
      let date: Date | null = null;

      switch (format) {
        case 'YYYYMMDDHHMMSS': {
          const year = parseInt(match[1].substring(0, 4), 10);
          const month = parseInt(match[1].substring(4, 6), 10) - 1;
          const day = parseInt(match[1].substring(6, 8), 10);
          const hour = parseInt(match[1].substring(8, 10), 10);
          const minute = parseInt(match[1].substring(10, 12), 10);
          const second = parseInt(match[1].substring(12, 14), 10);
          date = new Date(year, month, day, hour, minute, second);
          break;
        }
        case 'YYYYMMDD':
        case 'MIGRATION_YYYYMMDD': {
          const digits = match[1];
          const year = parseInt(digits.substring(0, 4), 10);
          const month = parseInt(digits.substring(4, 6), 10) - 1;
          const day = parseInt(digits.substring(6, 8), 10);
          date = new Date(year, month, day);
          break;
        }
        case 'YYYY-MM-DD': {
          const year = parseInt(match[1], 10);
          const month = parseInt(match[2], 10) - 1;
          const day = parseInt(match[3], 10);
          date = new Date(year, month, day);
          break;
        }
        case 'YYYY-MM-DD-HH-MM-SS': {
          const year = parseInt(match[1], 10);
          const month = parseInt(match[2], 10) - 1;
          const day = parseInt(match[3], 10);
          const hour = parseInt(match[4], 10);
          const minute = parseInt(match[5], 10);
          const second = parseInt(match[6], 10);
          date = new Date(year, month, day, hour, minute, second);
          break;
        }
        case 'PHASE': {
          // Use phase number as timestamp offset from a base date
          const phaseNum = parseInt(match[1], 10);
          date = new Date(2000 + phaseNum, 0, 1);
          break;
        }
        case 'SEMVER': {
          const major = parseInt(match[1], 10);
          const minor = parseInt(match[2], 10);
          const patch = parseInt(match[3], 10);
          // Create a sortable date: major years from 2000, minor months, patch days
          date = new Date(2000 + major, minor - 1, patch);
          break;
        }
        case 'YYYY': {
          const year = parseInt(match[1], 10);
          date = new Date(year, 0, 1);
          break;
        }
        case 'GENERIC': {
          const digits = match[1];
          if (digits.length >= 8) {
            const year = parseInt(digits.substring(0, 4), 10);
            const month = parseInt(digits.substring(4, 6), 10) - 1;
            const day = parseInt(digits.substring(6, 8), 10);
            date = new Date(year, month, day);
          } else if (digits.length >= 4) {
            const year = parseInt(digits.substring(0, 4), 10);
            date = new Date(year, 0, 1);
          } else {
            // Use as a numeric sort key with base date
            date = new Date(2000, 0, parseInt(digits, 10));
          }
          break;
        }
      }

      if (date && !isNaN(date.getTime())) {
        return date;
      }
    }
  }

  return null;
}

/**
 * Check if a file has a migration extension
 */
function isMigrationFile(filename: string, extensions: string[]): boolean {
  const ext = path.extname(filename).toLowerCase();
  return extensions.includes(ext);
}

/**
 * Collect migrations from source directories
 */
export function collectMigrations(
  sourceDirs: string[],
  extensions: string[] = DEFAULT_EXTENSIONS
): MigrationFile[] {
  const migrations: MigrationFile[] = [];

  for (const sourceDir of sourceDirs) {
    if (!fs.existsSync(sourceDir)) {
      console.warn(`Warning: Source directory does not exist: ${sourceDir}`);
      continue;
    }

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const filename = entry.name;
      if (!isMigrationFile(filename, extensions)) continue;

      const sourcePath = path.join(sourceDir, filename);
      const content = fs.readFileSync(sourcePath, 'utf-8');
      const timestamp = extractTimestamp(filename);
      const hash = computeHash(content);

      migrations.push({
        sourcePath,
        filename,
        content,
        timestamp,
        hash,
      });
    }
  }

  return migrations;
}

/**
 * Find duplicate migrations based on content hash
 */
function findDuplicates(migrations: MigrationFile[]): DuplicateEntry[] {
  const hashToSources: Map<string, string[]> = new Map();

  for (const migration of migrations) {
    const existing = hashToSources.get(migration.hash) || [];
    existing.push(migration.sourcePath);
    hashToSources.set(migration.hash, existing);
  }

  const duplicates: DuplicateEntry[] = [];
  for (const [hash, sources] of hashToSources.entries()) {
    if (sources.length > 1) {
      duplicates.push({ hash, sources });
    }
  }

  return duplicates;
}

/**
 * Generate sequential prefix (001_, 002_, etc.)
 */
function generateSequentialPrefix(index: number, total: number): string {
  // Determine padding based on total count
  const digits = Math.max(3, String(total).length);
  return String(index + 1).padStart(digits, '0') + '_';
}

/**
 * Generate a clean filename from original filename
 */
function generateNewFilename(originalFilename: string, prefix: string): string {
  // Remove existing numeric prefixes
  let cleanName = originalFilename;
  
  // Remove common timestamp prefixes like 20250117_, 001_, etc.
  cleanName = cleanName.replace(/^\d+[_-]+/, '');
  
  // Remove phase prefixes
  cleanName = cleanName.replace(/^phase\d+[a-z]?[_-]+/i, '');
  
  // Remove v-prefixes like v1.0.0_
  cleanName = cleanName.replace(/^v\d+\.\d+\.\d+[_-]+/i, '');
  
  // Remove migration_ prefix
  cleanName = cleanName.replace(/^migration[_-]+/i, '');

  // Ensure we have the extension
  const ext = path.extname(originalFilename);
  const baseName = path.basename(cleanName, ext);

  return `${prefix}${baseName}${ext}`;
}

/**
 * Sort migrations by timestamp (null timestamps go last)
 */
function sortMigrations(migrations: MigrationFile[]): MigrationFile[] {
  return [...migrations].sort((a, b) => {
    // If both have timestamps, compare them
    if (a.timestamp && b.timestamp) {
      return a.timestamp.getTime() - b.timestamp.getTime();
    }
    // Null timestamps go to the end
    if (!a.timestamp && b.timestamp) return 1;
    if (a.timestamp && !b.timestamp) return -1;
    // If both null, sort by filename
    return a.filename.localeCompare(b.filename);
  });
}

/**
 * Consolidate migrations: deduplicate, sort, and prepare for renaming
 */
export function consolidateMigrations(
  migrations: MigrationFile[],
  options: {
    removeDuplicates?: boolean;
  } = {}
): {
  uniqueMigrations: MigrationFile[];
  duplicates: DuplicateEntry[];
  migrationMap: Map<MigrationFile, { newFilename: string; prefix: string }>;
} {
  const { removeDuplicates = true } = options;

  // Find duplicates
  const duplicates = findDuplicates(migrations);
  const duplicateHashes = new Set(duplicates.map((d) => d.hash));

  // Filter to unique migrations
  const seenHashes = new Set<string>();
  const uniqueMigrations: MigrationFile[] = [];

  for (const migration of migrations) {
    if (duplicateHashes.has(migration.hash)) {
      if (removeDuplicates) {
        // Keep only the first occurrence of each duplicate
        if (seenHashes.has(migration.hash)) {
          continue;
        }
        seenHashes.add(migration.hash);
      }
    }
    uniqueMigrations.push(migration);
  }

  // Sort by timestamp
  const sortedMigrations = sortMigrations(uniqueMigrations);

  // Generate new filenames
  const migrationMap = new Map<MigrationFile, { newFilename: string; prefix: string }>();
  for (let i = 0; i < sortedMigrations.length; i++) {
    const migration = sortedMigrations[i];
    const prefix = generateSequentialPrefix(i, sortedMigrations.length);
    const newFilename = generateNewFilename(migration.filename, prefix);
    migrationMap.set(migration, { newFilename, prefix });
  }

  return {
    uniqueMigrations: sortedMigrations,
    duplicates,
    migrationMap,
  };
}

/**
 * Generate registry.json content
 */
export function generateRegistry(
  migrations: MigrationFile[],
  migrationMap: Map<MigrationFile, { newFilename: string; prefix: string }>,
  duplicates: DuplicateEntry[]
): Registry {
  const entries: MigrationEntry[] = [];

  for (const migration of migrations) {
    const mapping = migrationMap.get(migration);
    if (!mapping) continue;

    entries.push({
      filename: mapping.newFilename,
      originalFilename: migration.filename,
      sourcePath: migration.sourcePath,
      hash: migration.hash,
      timestamp: migration.timestamp?.toISOString() || null,
      sequentialPrefix: mapping.prefix,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    totalMigrations: entries.length,
    migrations: entries,
    duplicates,
  };
}

/**
 * Write migrations to target directory
 */
function writeMigrations(
  migrations: MigrationFile[],
  migrationMap: Map<MigrationFile, { newFilename: string; prefix: string }>,
  targetDir: string
): void {
  // Create target directory if it doesn't exist
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  for (const migration of migrations) {
    const mapping = migrationMap.get(migration);
    if (!mapping) continue;

    const targetPath = path.join(targetDir, mapping.newFilename);
    fs.writeFileSync(targetPath, migration.content, 'utf-8');
  }
}

/**
 * Write registry.json to target directory
 */
function writeRegistry(registry: Registry, targetDir: string): void {
  const registryPath = path.join(targetDir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}

// ============================================================================
// Main Function
// ============================================================================

export interface ConsolidationResult {
  success: boolean;
  migrationsProcessed: number;
  duplicatesFound: number;
  duplicatesRemoved: number;
  targetDir: string;
  errors: string[];
}

/**
 * Run the full consolidation process
 */
export function runConsolidation(
  options: ConsolidationOptions,
  dryRun: boolean = false
): ConsolidationResult {
  const errors: string[] = [];
  const { sourceDirs, targetDir, extensions = DEFAULT_EXTENSIONS } = options;

  try {
    // Step 1: Collect migrations
    console.log('Collecting migrations...');
    const migrations = collectMigrations(sourceDirs, extensions);
    console.log(`Found ${migrations.length} migration files`);

    if (migrations.length === 0) {
      return {
        success: true,
        migrationsProcessed: 0,
        duplicatesFound: 0,
        duplicatesRemoved: 0,
        targetDir,
        errors: ['No migrations found in source directories'],
      };
    }

    // Step 2: Consolidate (deduplicate and sort)
    console.log('Consolidating migrations...');
    const { uniqueMigrations, duplicates, migrationMap } = consolidateMigrations(migrations, {
      removeDuplicates: true,
    });

    const duplicatesRemoved = migrations.length - uniqueMigrations.length;
    console.log(`Found ${duplicates.length} sets of duplicates`);
    console.log(`Removed ${duplicatesRemoved} duplicate migrations`);
    console.log(`Consolidated to ${uniqueMigrations.length} unique migrations`);

    // Step 3: Generate registry
    console.log('Generating registry...');
    const registry = generateRegistry(uniqueMigrations, migrationMap, duplicates);

    // Print migration mapping
    console.log('\nMigration mapping:');
    for (const migration of uniqueMigrations) {
      const mapping = migrationMap.get(migration);
      if (mapping) {
        console.log(`  ${migration.filename} -> ${mapping.newFilename}`);
      }
    }

    // Step 4: Write files (unless dry run)
    if (!dryRun) {
      console.log(`\nWriting migrations to ${targetDir}...`);
      writeMigrations(uniqueMigrations, migrationMap, targetDir);
      writeRegistry(registry, targetDir);
      console.log('Done!');
    } else {
      console.log('\n[DRY RUN] No files were written');
    }

    return {
      success: true,
      migrationsProcessed: migrations.length,
      duplicatesFound: duplicates.length,
      duplicatesRemoved,
      targetDir,
      errors,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errors.push(errorMsg);
    return {
      success: false,
      migrationsProcessed: 0,
      duplicatesFound: 0,
      duplicatesRemoved: 0,
      targetDir,
      errors,
    };
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const help = args.includes('--help') || args.includes('-h');

  if (help) {
    console.log(`
Migration Consolidation Script

Usage: npx ts-node consolidate-migrations.ts [options]

Options:
  --dry-run, -n    Show what would be done without making changes
  --help, -h       Show this help message

Description:
  Consolidates migration files from multiple source directories into a single
  target directory. Files are sorted by timestamp, deduplicated by content hash,
  and renamed with sequential prefixes (001_, 002_, etc.).

Default source directory:
  - backend/database/migrations

Default target directory:
  - backend/database/migrations

Output:
  - Migrations written to target directory with sequential prefixes
  - registry.json with metadata for all migrations
`);
    process.exit(0);
  }

  // Default configuration
  const options: ConsolidationOptions = {
    sourceDirs: [path.resolve(process.cwd(), 'backend/database/migrations')],
    targetDir: path.resolve(process.cwd(), 'backend/database/migrations'),
  };

  const result = runConsolidation(options, dryRun);

  if (!result.success) {
    console.error('Consolidation failed:');
    result.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  console.log(`\nSummary:`);
  console.log(`  Migrations processed: ${result.migrationsProcessed}`);
  console.log(`  Duplicates found: ${result.duplicatesFound}`);
  console.log(`  Duplicates removed: ${result.duplicatesRemoved}`);
  console.log(`  Target directory: ${result.targetDir}`);
}

// Run if executed directly
if (require.main === module) {
  main();
}
