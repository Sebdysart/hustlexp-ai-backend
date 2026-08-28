import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyVitestOutcome } from './verify-vitest-outcome.mjs';

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
  testResults: [{
    name: 'complete.test.ts',
    status: 'passed',
    assertionResults: Array.from({ length: 42 }, (_, index) => ({
      status: 'passed',
      fullName: `complete assertion ${index + 1}`,
    })),
  }],
};

test('accepts only a complete zero-failure zero-skip Vitest report', () => {
  assert.deepEqual(verifyVitestOutcome(green), []);
});

test('rejects failures, skips, todo tests, and incomplete accounting', () => {
  for (const candidate of [
    { ...green, success: false, numPassedTests: 41, numFailedTests: 1 },
    { ...green, numPassedTests: 41, numPendingTests: 1 },
    { ...green, numPassedTests: 41, numTodoTests: 1 },
    { ...green, numPassedTests: 41 },
    { ...green, numPassedTestSuites: 11, numPendingTestSuites: 1 },
  ]) {
    assert.notEqual(verifyVitestOutcome(candidate).length, 0);
  }
});

test('rejects malformed or empty reports instead of inventing success', () => {
  assert.match(verifyVitestOutcome(null).join('\n'), /report must be an object/u);
  assert.match(verifyVitestOutcome({ success: true }).join('\n'), /numTotalTests/u);
});

test('requires exact per-assertion and per-file evidence instead of trusting aggregate counts', () => {
  const withoutEvidence = { ...green, testResults: undefined };
  assert.match(verifyVitestOutcome(withoutEvidence).join('\n'), /testResults must be an array/u);

  const incompleteEvidence = {
    ...green,
    testResults: [{
      ...green.testResults[0],
      assertionResults: green.testResults[0].assertionResults.slice(0, 41),
    }],
  };
  assert.match(verifyVitestOutcome(incompleteEvidence).join('\n'), /assertion evidence mismatch/u);

  const hiddenSkip = {
    ...green,
    testResults: [{
      ...green.testResults[0],
      assertionResults: green.testResults[0].assertionResults.map((assertion, index) =>
        index === 41 ? { ...assertion, status: 'skipped' } : assertion),
    }],
  };
  assert.match(verifyVitestOutcome(hiddenSkip).join('\n'), /non-passing assertions remain: skipped/u);

  const hiddenFileFailure = {
    ...green,
    testResults: [{ ...green.testResults[0], status: 'failed' }],
  };
  assert.match(verifyVitestOutcome(hiddenFileFailure).join('\n'), /non-passing test files remain/u);
});
