/**
 * Explicit test-only characterization adapter.
 *
 * The shipped guard is unconditionally frozen. Historical tests that exercise
 * the retired Task/PENDING-escrow mechanics receive this Vitest module mock so
 * they can continue proving legacy recovery behavior without adding a runtime
 * flag, callable capability, or production-bundle escape hatch.
 */
import { vi } from 'vitest';

vi.mock('../src/services/LegacyTaskMaterializationGuard.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/services/LegacyTaskMaterializationGuard.js')
  >();
  return {
    ...actual,
    legacyTaskMaterializationFailure: () => null,
  };
});
