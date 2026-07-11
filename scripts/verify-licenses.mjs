import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const forbidden = [];
const missing = [];

function licenseText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(licenseText).filter(Boolean).join(' OR ');
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type;
  return '';
}

function alternativeIsRestricted(alternative) {
  const normalized = alternative.toUpperCase();
  if (normalized.includes('LGPL')) return false;
  return /(?:^|[^A-Z])(?:AGPL|GPL|SSPL|BUSL|BUSINESS SOURCE)/.test(normalized);
}

function expressionIsRestricted(expression) {
  const alternatives = expression.split(/\s+OR\s+|\|\|/i).filter(Boolean);
  return alternatives.length > 0 && alternatives.every(alternativeIsRestricted);
}

for (const [relativePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!relativePath.startsWith('node_modules/') || metadata.dev) continue;
  const manifestPath = path.join(relativePath, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const license = licenseText(manifest.license ?? manifest.licenses);
  const name = manifest.name ?? relativePath;
  if (!license) missing.push(name);
  else if (expressionIsRestricted(license)) forbidden.push({ name, license });
}

const report = {
  ok: forbidden.length === 0,
  production_packages_scanned: Object.values(lock.packages ?? {}).filter((entry) => !entry.dev).length,
  forbidden,
  missing_license_metadata: [...new Set(missing)].sort(),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
