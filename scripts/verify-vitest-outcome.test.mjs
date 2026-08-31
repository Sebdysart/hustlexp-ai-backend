import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { requiredTestFiles, verifyVitestOutcome } from './verify-vitest-outcome.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const expectedTestFiles = ['backend/tests/unit/complete.test.ts'];
const verificationOptions = { expectedTestFiles, projectRoot };

const green = {
  success: true,
  numTotalTests: 42,
  numPassedTests: 42,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numTotalTestSuites: 12,
  numPassedTestSuites: 12,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  testResults: [
    {
      name: 'backend/tests/unit/complete.test.ts',
      status: 'passed',
      assertionResults: Array.from({ length: 42 }, (_, index) => ({
        status: 'passed',
        fullName: `complete assertion ${index + 1}`,
      })),
    },
  ],
};

test('accepts only a complete zero-failure zero-skip Vitest report', () => {
  assert.deepEqual(verifyVitestOutcome(green, verificationOptions), []);
});

test('rejects failures, skips, todo tests, and incomplete accounting', () => {
  for (const candidate of [
    { ...green, success: false, numPassedTests: 41, numFailedTests: 1 },
    { ...green, numPassedTests: 41, numPendingTests: 1 },
    { ...green, numPassedTests: 41, numTodoTests: 1 },
    { ...green, numPassedTests: 41 },
    { ...green, numPassedTestSuites: 11, numPendingTestSuites: 1 },
  ]) {
    assert.notEqual(verifyVitestOutcome(candidate, verificationOptions).length, 0);
  }
});

test('rejects malformed or empty reports instead of inventing success', () => {
  assert.match(
    verifyVitestOutcome(null, verificationOptions).join('\n'),
    /report must be an object/u
  );
  assert.match(
    verifyVitestOutcome({ success: true }, verificationOptions).join('\n'),
    /numTotalTests/u
  );
  assert.match(verifyVitestOutcome(green).join('\n'), /expected test inventory/u);
});

test('requires exact per-assertion and per-file evidence instead of trusting aggregate counts', () => {
  const withoutEvidence = { ...green, testResults: undefined };
  assert.match(
    verifyVitestOutcome(withoutEvidence, verificationOptions).join('\n'),
    /testResults must be an array/u
  );

  const incompleteEvidence = {
    ...green,
    testResults: [
      {
        ...green.testResults[0],
        assertionResults: green.testResults[0].assertionResults.slice(0, 41),
      },
    ],
  };
  assert.match(
    verifyVitestOutcome(incompleteEvidence, verificationOptions).join('\n'),
    /assertion evidence mismatch/u
  );

  const hiddenSkip = {
    ...green,
    testResults: [
      {
        ...green.testResults[0],
        assertionResults: green.testResults[0].assertionResults.map((assertion, index) =>
          index === 41 ? { ...assertion, status: 'skipped' } : assertion
        ),
      },
    ],
  };
  assert.match(
    verifyVitestOutcome(hiddenSkip, verificationOptions).join('\n'),
    /non-passing assertions remain: skipped/u
  );

  const hiddenFileFailure = {
    ...green,
    testResults: [{ ...green.testResults[0], status: 'failed' }],
  };
  assert.match(
    verifyVitestOutcome(hiddenFileFailure, verificationOptions).join('\n'),
    /non-passing test files remain/u
  );
});

test('requires a one-to-one report for the exact filesystem inventory', () => {
  const missing = verifyVitestOutcome(green, {
    expectedTestFiles: [...expectedTestFiles, 'backend/tests/system/missing.test.ts'],
    projectRoot,
  });
  assert.match(missing.join('\n'), /required test files missing from report/u);
  assert.match(missing.join('\n'), /test-file accounting mismatch/u);

  const duplicateReport = {
    ...green,
    numTotalTests: 84,
    numPassedTests: 84,
    testResults: [green.testResults[0], green.testResults[0]],
  };
  assert.match(
    verifyVitestOutcome(duplicateReport, verificationOptions).join('\n'),
    /duplicate test-file reports remain/u
  );

  const unexpected = {
    ...green,
    testResults: [
      {
        ...green.testResults[0],
        name: 'backend/tests/unit/unexpected.test.ts',
      },
    ],
  };
  assert.match(
    verifyVitestOutcome(unexpected, verificationOptions).join('\n'),
    /required test files missing from report/u
  );
  assert.match(
    verifyVitestOutcome(unexpected, verificationOptions).join('\n'),
    /unexpected test files in report/u
  );
});

test('rejects empty file evidence and paths outside the candidate checkout', () => {
  const emptyFile = {
    ...green,
    numTotalTests: 0,
    numPassedTests: 0,
    testResults: [{ ...green.testResults[0], assertionResults: [] }],
  };
  assert.match(
    verifyVitestOutcome(emptyFile, verificationOptions).join('\n'),
    /test file contains no assertion evidence/u
  );

  const escaped = {
    ...green,
    testResults: [{ ...green.testResults[0], name: '../outside.test.ts' }],
  };
  assert.match(
    verifyVitestOutcome(escaped, verificationOptions).join('\n'),
    /outside the project root/u
  );
});

test('discovers every candidate test file across the required cohort directories', async () => {
  const files = await requiredTestFiles(projectRoot);
  assert.ok(files.length > 0);
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.every((path) => /^backend\/tests\/.+\.test\.ts$/u.test(path)));
  for (const cohort of ['unit', 'integration', 'invariants', 'system']) {
    assert.ok(files.some((path) => path.startsWith(`backend/tests/${cohort}/`)));
  }
});
