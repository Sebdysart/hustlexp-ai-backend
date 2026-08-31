import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('../../src/services/LegacyTaskMaterializationGuard.js');

import {
  LEGACY_TASK_MATERIALIZATION_FROZEN_AUTHORITY,
  LEGACY_TASK_MATERIALIZATION_FROZEN_CODE,
  LEGACY_TASK_MATERIALIZATION_FROZEN_DISPOSITION,
  LEGACY_TASK_MATERIALIZATION_FROZEN_MESSAGE,
  LEGACY_TASK_MATERIALIZATION_REPLACEMENT,
  legacyTaskMaterializationFailure,
  legacyTaskMaterializationHealth,
  legacyTaskMaterializationMode,
  type LegacyTaskMaterializationLane,
} from '../../src/services/LegacyTaskMaterializationGuard.js';

describe('Universal V1 legacy task-materialization guard', () => {
  it('remains frozen even inside the actual Vitest worker', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.VITEST).toBe('true');
    expect(process.env.VITEST_WORKER_ID?.trim()).not.toBe('');
    expect(legacyTaskMaterializationMode({
      NODE_ENV: 'test',
      VITEST: 'true',
      VITEST_WORKER_ID: process.env.VITEST_WORKER_ID,
    })).toBe('frozen');
    expect(
      legacyTaskMaterializationFailure('task_create', {
        NODE_ENV: 'test',
        VITEST: 'true',
        VITEST_WORKER_ID: process.env.VITEST_WORKER_ID,
      }),
    ).toMatchObject({
      success: false,
      error: { code: LEGACY_TASK_MATERIALIZATION_FROZEN_CODE },
    });
  });

  it('fails closed for every environment and ignores forged runner or enable flags', () => {
    for (const nodeEnv of ['production', 'development', 'staging', 'test', undefined]) {
      expect(legacyTaskMaterializationMode({
        NODE_ENV: nodeEnv,
        HX_LEGACY_TASK_MATERIALIZATION_MODE: 'enabled',
        HX_LEGACY_TASK_MATERIALIZATION_ENABLED: 'true',
        VITEST: 'true',
        VITEST_WORKER_ID: 'forged-worker',
      })).toBe('frozen');
    }
  });

  it('returns one stable denial contract for every legacy materialization lane', () => {
    const lanes: LegacyTaskMaterializationLane[] = [
      'task_create',
      'task_create_in_transaction',
      'pending_escrow_create',
      'repository_escrow_create',
    ];

    for (const lane of lanes) {
      expect(legacyTaskMaterializationFailure(lane, {
        NODE_ENV: 'production',
        HX_LEGACY_TASK_MATERIALIZATION_MODE: 'enabled',
      })).toEqual({
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
      });
    }

    expect(legacyTaskMaterializationHealth({ NODE_ENV: 'production' })).toEqual({
      mode: 'frozen',
      acceptsLegacyTaskMaterialization: false,
      authority: LEGACY_TASK_MATERIALIZATION_FROZEN_AUTHORITY,
    });
  });

  it('contains no runtime test witness or caller-controlled override', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'backend/src/services/LegacyTaskMaterializationGuard.ts'),
      'utf8',
    );
    const testAdapter = readFileSync(
      resolve(
        process.cwd(),
        'backend/tests/legacy-task-materialization-compatibility.setup.ts',
      ),
      'utf8',
    );

    expect(source).not.toMatch(/VITEST|test_only|ISOLATED_VITEST_WITNESS|isolatedVitestWitness/u);
    expect(source).not.toMatch(/process\.(?:argv|execArgv|env)/u);
    expect(source).not.toMatch(/env\.HX_LEGACY_TASK_MATERIALIZATION_/u);
    expect(testAdapter).toContain("vi.mock('../src/services/LegacyTaskMaterializationGuard.js'");
    expect(testAdapter).toContain('legacyTaskMaterializationFailure: () => null');
  });
});
