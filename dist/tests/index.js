/**
 * TEST INDEX (BUILD_GUIDE Phase 5)
 *
 * Central index of all test suites.
 *
 * Test Categories:
 * - kill-tests: Invariant violation tests (must fail)
 * - e2e-integration: Full lifecycle tests
 * - fuzz-tests: Random/chaos testing
 *
 * Run Commands:
 *   npm run test          - All tests
 *   npm run test:kill     - Kill tests only
 *   npm run test:e2e      - E2E integration tests
 *   npm run test:fuzz     - Fuzz/chaos tests
 *   npm run test:invariants - Tests with INV- prefix
 *   npm run test:coverage - With coverage report
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
// Re-export test utilities if needed
export * from './test-utils.js';
//# sourceMappingURL=index.js.map