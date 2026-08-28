import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

export function verifyVitestOutcome(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return ['report must be an object'];
  }
  const errors = [];
  const requiredCounts = [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites',
  ];
  for (const name of requiredCounts) {
    if (!isCount(report[name])) errors.push(`${name} must be a non-negative integer`);
  }
  if (errors.length > 0) return errors;

  const todo = report.numTodoTests ?? 0;
  if (!isCount(todo)) errors.push('numTodoTests must be a non-negative integer when present');
  if (report.success !== true) errors.push('Vitest did not report success');
  if (report.numTotalTests === 0) errors.push('Vitest report contains no tests');
  if (report.numFailedTests !== 0) errors.push(`${report.numFailedTests} tests failed`);
  if (report.numPendingTests !== 0) errors.push(`${report.numPendingTests} tests were skipped or pending`);
  if (todo !== 0) errors.push(`${todo} tests remain todo`);
  if (report.numFailedTestSuites !== 0) {
    errors.push(`${report.numFailedTestSuites} test suites failed`);
  }
  if (report.numPendingTestSuites !== 0) {
    errors.push(`${report.numPendingTestSuites} test suites were skipped or pending`);
  }

  const accountedTests = report.numPassedTests + report.numFailedTests + report.numPendingTests + todo;
  if (accountedTests !== report.numTotalTests) {
    errors.push(`test accounting mismatch: total ${report.numTotalTests}, accounted ${accountedTests}`);
  }
  const accountedSuites = report.numPassedTestSuites
    + report.numFailedTestSuites
    + report.numPendingTestSuites;
  if (accountedSuites !== report.numTotalTestSuites) {
    errors.push(
      `suite accounting mismatch: total ${report.numTotalTestSuites}, accounted ${accountedSuites}`,
    );
  }

  if (!Array.isArray(report.testResults)) {
    errors.push('testResults must be an array with exact assertion evidence');
    return errors;
  }

  const assertions = [];
  const nonPassingFiles = [];
  for (const result of report.testResults) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      errors.push('testResults contains a malformed test-file result');
      continue;
    }
    if (result.status !== 'passed') {
      nonPassingFiles.push(`${result.status || 'unknown'}: ${result.name || 'unnamed test file'}`);
    }
    if (!Array.isArray(result.assertionResults)) {
      errors.push(`assertionResults must be an array for ${result.name || 'unnamed test file'}`);
      continue;
    }
    for (const assertion of result.assertionResults) {
      assertions.push({ assertion, result });
    }
  }
  if (assertions.length !== report.numTotalTests) {
    errors.push(
      `assertion evidence mismatch: total ${report.numTotalTests}, recorded ${assertions.length}`,
    );
  }
  if (nonPassingFiles.length > 0) {
    errors.push(`non-passing test files remain: ${nonPassingFiles.slice(0, 10).join(' | ')}`);
  }

  const nonPassingAssertions = assertions
    .filter(({ assertion }) =>
      !assertion || typeof assertion !== 'object' || Array.isArray(assertion)
      || assertion.status !== 'passed')
    .map(({ assertion, result }) => {
      const status = assertion && typeof assertion === 'object' && !Array.isArray(assertion)
        ? assertion.status
        : 'malformed';
      const fullName = assertion && typeof assertion === 'object' && !Array.isArray(assertion)
        ? assertion.fullName
        : null;
      return `${status || 'unknown'}: ${fullName || result.name || 'unnamed assertion'}`;
    });
  if (nonPassingAssertions.length > 0) {
    errors.push(`non-passing assertions remain: ${nonPassingAssertions.slice(0, 10).join(' | ')}`);
  }
  return errors;
}

async function main() {
  const path = resolve(process.argv[2] ?? 'reports/vitest.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  const errors = verifyVitestOutcome(report);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Verified complete Vitest outcome: ${report.numPassedTests}/${report.numTotalTests} passed, zero skipped/todo`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
