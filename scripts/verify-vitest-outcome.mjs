import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function normalizedRelativePath(projectRoot, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const normalized = relative(projectRoot, resolve(projectRoot, candidate)).replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../')) {
    // JSON evidence can be copied out of its original container or runner.
    // Accept only the canonical test-tree suffix; the exact inventory check
    // below still rejects every missing, duplicated, or invented file.
    const portable = candidate.replaceAll('\\', '/');
    const marker = '/backend/tests/';
    const markerIndex = portable.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    return portable.slice(markerIndex + 1);
  }
  return normalized;
}

async function findTestFiles(directory, projectRoot) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findTestFiles(path, projectRoot)));
    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(relative(projectRoot, path).replaceAll('\\', '/'));
    }
  }
  return files;
}

export async function requiredTestFiles(projectRoot) {
  return (await findTestFiles(resolve(projectRoot, 'backend', 'tests'), projectRoot)).sort();
}

export function verifyVitestOutcome(
  report,
  { expectedTestFiles, projectRoot = process.cwd() } = {}
) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return ['report must be an object'];
  }
  const errors = [];
  if (!Array.isArray(expectedTestFiles) || expectedTestFiles.length === 0) {
    errors.push('expected test inventory must be a non-empty array');
  }
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
  if (errors.some((error) => error.includes('must be a non-negative integer'))) return errors;

  const todo = report.numTodoTests ?? 0;
  if (!isCount(todo)) errors.push('numTodoTests must be a non-negative integer when present');
  if (report.success !== true) errors.push('Vitest did not report success');
  if (report.numTotalTests === 0) errors.push('Vitest report contains no tests');
  if (report.numFailedTests !== 0) errors.push(`${report.numFailedTests} tests failed`);
  if (report.numPendingTests !== 0)
    errors.push(`${report.numPendingTests} tests were skipped or pending`);
  if (todo !== 0) errors.push(`${todo} tests remain todo`);
  if (report.numFailedTestSuites !== 0) {
    errors.push(`${report.numFailedTestSuites} test suites failed`);
  }
  if (report.numPendingTestSuites !== 0) {
    errors.push(`${report.numPendingTestSuites} test suites were skipped or pending`);
  }

  const accountedTests =
    report.numPassedTests + report.numFailedTests + report.numPendingTests + todo;
  if (accountedTests !== report.numTotalTests) {
    errors.push(
      `test accounting mismatch: total ${report.numTotalTests}, accounted ${accountedTests}`
    );
  }
  const accountedSuites =
    report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites;
  if (accountedSuites !== report.numTotalTestSuites) {
    errors.push(
      `suite accounting mismatch: total ${report.numTotalTestSuites}, accounted ${accountedSuites}`
    );
  }

  if (!Array.isArray(report.testResults)) {
    errors.push('testResults must be an array with exact assertion evidence');
    return errors;
  }

  const assertions = [];
  const nonPassingFiles = [];
  const reportedFiles = [];
  for (const result of report.testResults) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      errors.push('testResults contains a malformed test-file result');
      continue;
    }
    const reportedPath = normalizedRelativePath(projectRoot, result.name);
    if (!reportedPath) {
      errors.push(
        `test result path is outside the project root: ${result.name || 'unnamed test file'}`
      );
    } else {
      reportedFiles.push(reportedPath);
    }
    if (result.status !== 'passed') {
      nonPassingFiles.push(`${result.status || 'unknown'}: ${result.name || 'unnamed test file'}`);
    }
    if (!Array.isArray(result.assertionResults)) {
      errors.push(`assertionResults must be an array for ${result.name || 'unnamed test file'}`);
      continue;
    }
    if (result.assertionResults.length === 0) {
      errors.push(
        `test file contains no assertion evidence: ${result.name || 'unnamed test file'}`
      );
    }
    for (const assertion of result.assertionResults) {
      assertions.push({ assertion, result });
    }
  }
  if (assertions.length !== report.numTotalTests) {
    errors.push(
      `assertion evidence mismatch: total ${report.numTotalTests}, recorded ${assertions.length}`
    );
  }
  if (nonPassingFiles.length > 0) {
    errors.push(`non-passing test files remain: ${nonPassingFiles.slice(0, 10).join(' | ')}`);
  }

  if (Array.isArray(expectedTestFiles) && expectedTestFiles.length > 0) {
    const normalizedExpected = expectedTestFiles.map((path) =>
      normalizedRelativePath(projectRoot, path)
    );
    if (normalizedExpected.some((path) => !path)) {
      errors.push('expected test inventory contains an invalid or out-of-root path');
    } else {
      const expected = new Set(normalizedExpected);
      if (expected.size !== normalizedExpected.length) {
        errors.push('expected test inventory contains duplicate paths');
      }
      const reported = new Set(reportedFiles);
      const duplicateReports = [
        ...new Set(reportedFiles.filter((path, index) => reportedFiles.indexOf(path) !== index)),
      ].sort();
      const missing = [...expected].filter((path) => !reported.has(path)).sort();
      const unexpected = [...reported].filter((path) => !expected.has(path)).sort();
      if (duplicateReports.length > 0) {
        errors.push(
          `duplicate test-file reports remain: ${duplicateReports.slice(0, 10).join(' | ')}`
        );
      }
      if (missing.length > 0) {
        errors.push(`required test files missing from report: ${missing.slice(0, 10).join(' | ')}`);
      }
      if (unexpected.length > 0) {
        errors.push(`unexpected test files in report: ${unexpected.slice(0, 10).join(' | ')}`);
      }
      if (reportedFiles.length !== expectedTestFiles.length) {
        errors.push(
          `test-file accounting mismatch: expected ${expectedTestFiles.length}, recorded ${reportedFiles.length}`
        );
      }
    }
  }

  const nonPassingAssertions = assertions
    .filter(
      ({ assertion }) =>
        !assertion ||
        typeof assertion !== 'object' ||
        Array.isArray(assertion) ||
        assertion.status !== 'passed'
    )
    .map(({ assertion, result }) => {
      const status =
        assertion && typeof assertion === 'object' && !Array.isArray(assertion)
          ? assertion.status
          : 'malformed';
      const fullName =
        assertion && typeof assertion === 'object' && !Array.isArray(assertion)
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
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const report = JSON.parse(await readFile(path, 'utf8'));
  const expectedTestFiles = await requiredTestFiles(projectRoot);
  const errors = verifyVitestOutcome(report, { expectedTestFiles, projectRoot });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Verified complete Vitest outcome: ${report.numPassedTests}/${report.numTotalTests} passed, zero skipped/todo`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
