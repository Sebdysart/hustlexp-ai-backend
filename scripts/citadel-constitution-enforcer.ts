import fs from 'fs';
import {
  checkLedgerImmutability,
  checkAmountPositivity,
  checkNoDirectDbInRouters,
} from './citadel-rules/financial.js';
import { checkStateMachineTransitions } from './citadel-rules/state-machine.js';
import type { Violation } from './citadel-rules/financial.js';

// Get changed files from diff
const changedFiles = (process.env.CHANGED_FILES ?? '')
  .split(',')
  .map(f => f.trim())
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('scripts/'));

if (!changedFiles.length) {
  console.log('No source files to check — constitution enforcer skipping.');
  process.exit(0);
}

console.log(`Citadel Constitution: checking ${changedFiles.length} file(s)...`);

const allViolations: Violation[] = [];

for (const file of changedFiles) {
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, 'utf-8');

  allViolations.push(
    ...checkLedgerImmutability(source, file),
    ...checkAmountPositivity(source, file),
    ...checkNoDirectDbInRouters(source, file),
    ...checkStateMachineTransitions(source, file),
  );
}

if (allViolations.length > 0) {
  console.error('\nCITADEL: Constitutional violations detected:\n');
  for (const v of allViolations) {
    console.error(`  [${v.invariant}] ${v.file}:${v.line} — ${v.message}`);
  }
  console.error(`\nTotal: ${allViolations.length} violation(s). Fix before merge.`);

  // Write violations to file for PR comment
  fs.writeFileSync(
    'citadel-constitution-report.md',
    `## Constitutional Violations\n\n` +
    allViolations.map(v =>
      `- **[${v.invariant}]** \`${v.file}:${v.line}\` — ${v.message}`
    ).join('\n'),
  );

  process.exit(1);
}

console.log(`Citadel Constitution: all ${changedFiles.length} file(s) clean.`);
fs.writeFileSync('citadel-constitution-report.md', '## Constitutional Check: All Clear\n');
