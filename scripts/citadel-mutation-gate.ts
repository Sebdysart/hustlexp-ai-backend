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

// Parse report and compute mutation score from mutant statuses
if (!fs.existsSync('stryker-report.json')) {
  console.error('Citadel: stryker-report.json not found after successful run');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync('stryker-report.json', 'utf-8')) as {
  files: Record<string, { mutants: { status: string }[] }>;
};

let killed = 0, timeout = 0, survived = 0, noCoverage = 0;

for (const file of Object.values(report.files ?? {})) {
  for (const mutant of file.mutants ?? []) {
    switch (mutant.status) {
      case 'Killed':      killed++;      break;
      case 'Timeout':     timeout++;     break;
      case 'Survived':    survived++;    break;
      case 'NoCoverage':  noCoverage++;  break;
      // Ignored, CompileError, RuntimeError, Pending — excluded from score
    }
  }
}

const detected = killed + timeout;
const total = killed + timeout + survived + noCoverage;
const score = total > 0 ? (detected / total) * 100 : 100; // 100% if no mutants

console.log(`Citadel: mutation score ${score.toFixed(1)}% — gate passed`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `mutation_score=${score.toFixed(1)}\n`);
}
