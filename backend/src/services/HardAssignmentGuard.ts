import type { ServiceResult } from '../types.js';

export type HardAssignmentLane =
  | 'instant_accept'
  | 'mutual_consent_accept'
  | 'poster_assignment'
  | 'engine_reservation'
  | 'service_business_assignment'
  | 'squad_task_accept'
  | 'squad_task_start'
  | 'repository_assignment';
export type HardAssignmentMode = 'enabled' | 'frozen';
type Environment = Record<string, string | undefined>;
interface AssignmentRuntimeBoundary {
  isolatedTestRunner: boolean;
}

export const HARD_ASSIGNMENT_FROZEN_CODE = 'HARD_ASSIGNMENT_FROZEN';
export const HARD_ASSIGNMENT_FROZEN_AUTHORITY = 'UNIVERSAL_V1_HARD_ASSIGNMENT_HELD';
export const HARD_ASSIGNMENT_FROZEN_MESSAGE =
  'Hard assignment is disabled for Universal V1. Provider interest, eligibility, estimates, and conditional holds do not assign a provider.';

function isIsolatedTestRunner(): boolean {
  const runnerEvidence = [...process.argv, ...process.execArgv]
    .some((argument) => /(?:^|\/)(?:@?vitest|vite-node)(?:\/|\.|$)/u.test(argument));
  const stackEvidence = new Error().stack?.includes('/node_modules/@vitest/') === true;
  return process.env.VITEST === 'true'
    && typeof process.env.VITEST_WORKER_ID === 'string'
    && (runnerEvidence || stackEvidence);
}

/**
 * No deployed environment can enable assignment with configuration alone.
 * Legacy assignment behavior remains executable only inside the isolated
 * Vitest compatibility cohort so it can be tested while production stays held.
 */
export function hardAssignmentMode(
  env: Environment = process.env,
  runtime?: AssignmentRuntimeBoundary,
): HardAssignmentMode {
  const configured = env.HX_HARD_ASSIGNMENT_MODE?.trim().toLowerCase();
  if (configured === 'frozen') return 'frozen';
  const isolatedTestRunner = runtime?.isolatedTestRunner ?? isIsolatedTestRunner();
  return isolatedTestRunner
    && configured === 'enabled'
    && env.NODE_ENV === 'test'
    ? 'enabled'
    : 'frozen';
}

export function hardAssignmentFailure(
  lane: HardAssignmentLane,
  env: Environment = process.env,
): Extract<ServiceResult<never>, { success: false }> | null {
  if (hardAssignmentMode(env) === 'enabled') return null;
  return {
    success: false,
    error: {
      code: HARD_ASSIGNMENT_FROZEN_CODE,
      message: HARD_ASSIGNMENT_FROZEN_MESSAGE,
      details: { lane, authority: HARD_ASSIGNMENT_FROZEN_AUTHORITY },
    },
  };
}

export function hardAssignmentHealth(env: Environment = process.env): {
  mode: HardAssignmentMode;
  acceptsHardAssignment: boolean;
  authority: typeof HARD_ASSIGNMENT_FROZEN_AUTHORITY;
} {
  const mode = hardAssignmentMode(env);
  return {
    mode,
    acceptsHardAssignment: mode === 'enabled',
    authority: HARD_ASSIGNMENT_FROZEN_AUTHORITY,
  };
}
