import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const COVERAGE_FILE = path.join(process.cwd(), 'coverage', 'coverage-final.json');
const NON_EXECUTABLE = /(?:\.d\.ts$|\/types\.ts$|\/routers\/index\.ts$)/;

function addChangedRange(result, file, start, count) {
  const lines = result.get(file) ?? new Set();
  for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
  result.set(file, lines);
}

function changedLines() {
  const result = new Map();
  const diff = execFileSync(
    'git',
    ['diff', '--unified=0', '--no-color', 'HEAD', '--', 'backend/src'],
    { encoding: 'utf8' },
  );
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      if (NON_EXECUTABLE.test(file)) file = null;
      continue;
    }
    if (!file || !line.startsWith('@@')) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    addChangedRange(result, file, Number(match[1]), match[2] === undefined ? 1 : Number(match[2]));
  }

  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', 'backend/src'],
    { encoding: 'utf8' },
  ).split('\n').filter(Boolean);
  for (const file of untracked) {
    if (!file.endsWith('.ts') || NON_EXECUTABLE.test(file)) continue;
    addChangedRange(result, file, 1, readFileSync(file, 'utf8').split(/\r?\n/).length);
  }
  return result;
}

if (!existsSync(COVERAGE_FILE)) {
  console.error(JSON.stringify({ ok: false, reason: 'coverage/coverage-final.json missing' }));
  process.exit(1);
}

const coverage = JSON.parse(readFileSync(COVERAGE_FILE, 'utf8'));
const byPath = new Map(
  Object.entries(coverage).map(([file, entry]) => [realpathSync(file), entry]),
);
const missingFiles = [];
const uncovered = [];
let executableChangedLines = 0;

for (const [relativeFile, lines] of changedLines()) {
  if (!existsSync(relativeFile)) continue;
  const entry = byPath.get(realpathSync(relativeFile));
  if (!entry) {
    missingFiles.push(relativeFile);
    continue;
  }
  const hitsByLine = new Map();
  for (const [statementId, location] of Object.entries(entry.statementMap ?? {})) {
    const line = location.start.line;
    const hits = Number(entry.s?.[statementId] ?? 0);
    const current = hitsByLine.get(line);
    hitsByLine.set(line, current === undefined ? hits : Math.min(current, hits));
  }
  for (const line of lines) {
    if (!hitsByLine.has(line)) continue;
    executableChangedLines += 1;
    if ((hitsByLine.get(line) ?? 0) === 0) uncovered.push(`${relativeFile}:${line}`);
  }
}

const report = {
  ok: missingFiles.length === 0 && uncovered.length === 0,
  executable_changed_lines: executableChangedLines,
  uncovered_changed_lines: uncovered,
  missing_coverage_files: missingFiles,
  required_delta_coverage_percent: 100,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
