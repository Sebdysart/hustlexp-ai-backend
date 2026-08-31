import type { ServiceResult } from '../types.js';

export type LegacyTaskMaterializationLane =
  | 'task_create'
  | 'task_create_in_transaction'
  | 'pending_escrow_create'
  | 'repository_escrow_create';
export type LegacyTaskMaterializationMode = 'frozen';
type Environment = Readonly<Record<string, string | undefined>>;

export const LEGACY_TASK_MATERIALIZATION_FROZEN_CODE =
  'LEGACY_TASK_MATERIALIZATION_FROZEN';
export const LEGACY_TASK_MATERIALIZATION_FROZEN_AUTHORITY =
  'UNIVERSAL_V1_TASK_MATERIALIZATION_AUTHORITY';
export const LEGACY_TASK_MATERIALIZATION_FROZEN_DISPOSITION = 'FROZEN';
export const LEGACY_TASK_MATERIALIZATION_REPLACEMENT =
  'UNIVERSAL_V1_TASKDRAFT_TO_WORK_ORDER';
export const LEGACY_TASK_MATERIALIZATION_FROZEN_MESSAGE =
  'Legacy direct Task and PENDING escrow materialization is frozen. Use the Universal V1 TaskDraft, routing, estimate, eligibility, conditional-hold, fake Financial Security Event, and Work Order lifecycle. No legacy Task or PENDING escrow record was created.';

/**
 * Runtime code has no compatibility capability. Tests that still characterize
 * historical mechanics use a Vitest module mock located under backend/tests;
 * that adapter is not imported by, nor callable from, this production module.
 */
export function legacyTaskMaterializationMode(
  _env: Environment = {},
): LegacyTaskMaterializationMode {
  return 'frozen';
}

export function legacyTaskMaterializationFailure(
  lane: LegacyTaskMaterializationLane,
  _env: Environment = {},
): Extract<ServiceResult<never>, { success: false }> | null {
  return {
    success: false,
    error: {
      code: LEGACY_TASK_MATERIALIZATION_FROZEN_CODE,
      message: LEGACY_TASK_MATERIALIZATION_FROZEN_MESSAGE,
      details: {
        lane,
        authority: LEGACY_TASK_MATERIALIZATION_FROZEN_AUTHORITY,
        disposition: LEGACY_TASK_MATERIALIZATION_FROZEN_DISPOSITION,
        replacement: LEGACY_TASK_MATERIALIZATION_REPLACEMENT,
      },
    },
  };
}

export function legacyTaskMaterializationHealth(env: Environment = {}): {
  mode: LegacyTaskMaterializationMode;
  acceptsLegacyTaskMaterialization: boolean;
  authority: typeof LEGACY_TASK_MATERIALIZATION_FROZEN_AUTHORITY;
} {
  const mode = legacyTaskMaterializationMode(env);
  return {
    mode,
    acceptsLegacyTaskMaterialization: false,
    authority: LEGACY_TASK_MATERIALIZATION_FROZEN_AUTHORITY,
  };
}
