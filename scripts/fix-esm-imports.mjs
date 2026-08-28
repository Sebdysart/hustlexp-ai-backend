#!/usr/bin/env node
/**
 * Add .js to relative imports in backend/src for Node ESM resolution.
 * Run from repo root: node scripts/fix-esm-imports.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, statSync } from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const backendSrc = join(root, 'backend', 'src');

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'dist') {
      yield* walk(full);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

// Relative import: ./ or ../ path; skip if already has extension .js, .mjs, .json, .cjs
function addJsToRelativeImports(content) {
  return content.replace(
    /(from\s+)(['"])(\.\.?\/[^'"]+)(\2)/g,
    (_, from, quote, path, _q2) => {
      if (/\.(js|mjs|cjs|json)$/i.test(path)) return from + quote + path + quote;
      return from + quote + path + '.js' + quote;
    }
  );
}

let count = 0;
for (const file of walk(backendSrc)) {
  const content = readFileSync(file, 'utf8');
  const next = addJsToRelativeImports(content);
  if (next !== content) {
    writeFileSync(file, next);
    count++;
    console.log('Fixed:', file.replace(root, ''));
  }
}
console.log('Done. Updated', count, 'files.');
