export const PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID: string | null = null;
export const PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID: string | null = null;

export type HostedNonproductionEnvironment = 'preview' | 'staging';

/**
 * Protected-source identity enrollment for hosted nonproduction effects.
 *
 * Names are descriptive metadata, not authority. Until the exact Railway
 * project and persistent staging environment IDs are reviewed and pinned in
 * source, hosted schema and fake-financial effects remain deliberately held.
 */
export function nonproductionRailwayTargetError(input: {
  environment: HostedNonproductionEnvironment;
  projectId: string;
  environmentId: string;
  environmentName: string;
}): string | null {
  if (!PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID) {
    return 'NONPRODUCTION_RAILWAY_PROJECT_NOT_ENROLLED';
  }
  if (input.projectId !== PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID) {
    return 'NONPRODUCTION_RAILWAY_PROJECT_ID_MISMATCH';
  }
  if (input.environment === 'staging') {
    if (!PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID) {
      return 'NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_NOT_ENROLLED';
    }
    if (input.environmentId !== PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID) {
      return 'NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID_MISMATCH';
    }
    if (input.environmentName !== 'staging') {
      return 'NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_NAME_MISMATCH';
    }
    return null;
  }
  if (!input.environmentName.startsWith('pr-') && !input.environmentName.startsWith('preview-')) {
    return 'NONPRODUCTION_RAILWAY_PREVIEW_ENVIRONMENT_NAME_MISMATCH';
  }
  return null;
}
