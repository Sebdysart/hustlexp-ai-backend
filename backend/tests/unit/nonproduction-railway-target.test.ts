import { describe, expect, it } from 'vitest';

import {
  nonproductionRailwayTargetError,
  PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID,
  PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID,
} from '../../src/nonproductionRailwayTarget.js';

describe('protected Railway nonproduction target identity', () => {
  it('keeps hosted effects held until exact reviewed IDs are enrolled in source', () => {
    expect(PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID).toBeNull();
    expect(PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID).toBeNull();

    for (const input of [
      {
        environment: 'staging' as const,
        projectId: 'self-reported-project-id',
        environmentId: 'self-reported-staging-id',
        environmentName: 'staging',
      },
      {
        environment: 'preview' as const,
        projectId: 'self-reported-project-id',
        environmentId: 'self-reported-preview-id',
        environmentName: 'pr-123',
      },
    ]) {
      expect(nonproductionRailwayTargetError(input)).toBe(
        'NONPRODUCTION_RAILWAY_PROJECT_NOT_ENROLLED',
      );
    }
  });

  it('does not treat a duplicate project or environment name as authority', () => {
    expect(nonproductionRailwayTargetError({
      environment: 'staging',
      projectId: 'attacker-controlled-project-with-same-name',
      environmentId: 'attacker-controlled-environment',
      environmentName: 'staging',
    })).toBe('NONPRODUCTION_RAILWAY_PROJECT_NOT_ENROLLED');
  });
});
