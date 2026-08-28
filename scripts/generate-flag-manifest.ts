/**
 * generate-flag-manifest.ts
 *
 * Scans the backend codebase for feature flag references and outputs
 * a JSON manifest of known flag names to stdout.
 *
 * Since flags are stored in a database table (feature_flags) with
 * no static seed list, this script extracts flag names from:
 * 1. getFlagForUser("flagName", ...) calls in backend code
 * 2. Known flag name patterns from routers and services
 * 3. Migration SQL seed data (if any)
 *
 * Usage: npx tsx scripts/generate-flag-manifest.ts > flag-manifest.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FlagManifest {
  generatedAt: string;
  flags: string[];
  source: string;
}

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      results.push(...findFiles(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractFlagNames(content: string): string[] {
  const flags: string[] = [];

  // Pattern 1: getFlagForUser("flag_name", ...)
  const getFlagPattern = /getFlagForUser\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = getFlagPattern.exec(content)) !== null) {
    flags.push(match[1]);
  }

  // Pattern 2: setFlag({ name: "flag_name", ... })
  const setFlagPattern = /setFlag\(\s*\{[^}]*name:\s*['"]([^'"]+)['"]/g;
  while ((match = setFlagPattern.exec(content)) !== null) {
    flags.push(match[1]);
  }

  // Pattern 3: isEnabled("flag_name") in test/seed data
  const isEnabledPattern = /isEnabled\(\s*['"]([^'"]+)['"]/g;
  while ((match = isEnabledPattern.exec(content)) !== null) {
    flags.push(match[1]);
  }

  return flags;
}

function extractFlagsFromSQL(content: string): string[] {
  const flags: string[] = [];
  // Pattern: INSERT INTO feature_flags ... VALUES ('flag_name', ...)
  const insertPattern = /INSERT\s+INTO\s+feature_flags[^;]*VALUES\s*\(\s*'([^']+)'/gi;
  let match: RegExpExecArray | null;
  while ((match = insertPattern.exec(content)) !== null) {
    flags.push(match[1]);
  }
  return flags;
}

function main(): void {
  const backendSrc = path.resolve(__dirname, '../backend/src');
  const migrationsDir = path.resolve(__dirname, '../migrations');

  const allFlags = new Set<string>();

  // Scan TypeScript source files
  const tsFiles = findFiles(backendSrc, '.ts');
  for (const filePath of tsFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const flags = extractFlagNames(content);
    for (const flag of flags) {
      allFlags.add(flag);
    }
  }

  // Scan migration SQL files
  const sqlFiles = findFiles(migrationsDir, '.sql');
  for (const filePath of sqlFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const flags = extractFlagsFromSQL(content);
    for (const flag of flags) {
      allFlags.add(flag);
    }
  }

  const manifest: FlagManifest = {
    generatedAt: new Date().toISOString(),
    flags: [...allFlags].sort(),
    source: 'static-analysis',
  };

  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

main();
