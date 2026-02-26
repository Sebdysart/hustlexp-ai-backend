import { execSync } from 'child_process';
import fs from 'fs';

const changedFiles = (process.env.CHANGED_FILES ?? '').split(',').filter(Boolean);

// Only mutate source files (not tests, scripts, or config)
const mutateTargets = changedFiles
  .filter(f => f.startsWith('backend/src/') && f.endsWith('.ts'))
  .join(',');

if (!mutateTargets) {
  console.log('No source files changed — skipping mutation gate.');
  process.exit(0);
}

process.env.MUTATE_FILES = mutateTargets;

console.log(`Citadel: mutating ${mutateTargets.split(',').length} file(s)...`);

try {
  execSync('npx stryker run', { stdio: 'inherit' });
} catch {
  console.error('Citadel: mutation score below 92% threshold');
  process.exit(1);
}

// Parse report and emit GitHub output
const report = JSON.parse(fs.readFileSync('stryker-report.json', 'utf-8'));
const score = report.mutationScore ?? 0;
console.log(`Citadel: mutation score ${score.toFixed(1)}% — gate passed`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `mutation_score=${score.toFixed(1)}\n`);
}
