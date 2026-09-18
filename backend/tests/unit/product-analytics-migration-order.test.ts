import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

describe('analytics migration prerequisite order', () => {
  const index = (name: string) => REQUIRED_MIGRATION_FILES.findIndex((migration) => migration.name === name);
  it.each([
    ['20260718_business_workspace_contract', '20260910_business_task_proposals'],
    ['010_web_platform_tables', '20260910_business_task_proposals'],
    ['20260718_business_workspace_contract', '20260910_task_completion_verifications'],
    ['010_web_platform_tables', '20260915_support_threads'],
    ['20260910_business_task_proposals', '20260915_support_threads'],
    ['20260915_support_threads', '20260916_product_analytics'],
  ])('applies %s before its dependent %s', (prerequisite, dependent) => {
    expect(index(prerequisite)).toBeGreaterThanOrEqual(0);
    expect(index(dependent)).toBeGreaterThan(index(prerequisite));
  });
  it('preserves one stable checkpoint and file per reordered migration', () => {
    for (const name of ['20260910_business_task_proposals', '20260910_task_completion_verifications', '20260915_support_threads']) {
      expect(REQUIRED_MIGRATION_FILES.filter((migration) => migration.name === name))
        .toEqual([{ name, fileName: `${name}.sql` }]);
    }
  });
});
