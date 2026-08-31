import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HARD_ASSIGNMENT_FROZEN_AUTHORITY,
  HARD_ASSIGNMENT_FROZEN_CODE,
  hardAssignmentFailure,
  hardAssignmentHealth,
  hardAssignmentMode,
  type HardAssignmentLane,
} from '../../src/services/HardAssignmentGuard.js';

const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Universal V1 hard-assignment incident guard', () => {
  it('cannot be enabled by deployed configuration', () => {
    const enabled = { NODE_ENV: 'test', HX_HARD_ASSIGNMENT_MODE: 'enabled' };
    expect(hardAssignmentMode(enabled, { isolatedTestRunner: true })).toBe('enabled');
    expect(hardAssignmentMode(enabled, { isolatedTestRunner: false })).toBe('frozen');
    expect(hardAssignmentMode(
      { NODE_ENV: 'production', HX_HARD_ASSIGNMENT_MODE: 'enabled' },
      { isolatedTestRunner: true },
    )).toBe('frozen');
    expect(hardAssignmentMode(
      { NODE_ENV: 'development', HX_HARD_ASSIGNMENT_MODE: 'enabled' },
      { isolatedTestRunner: true },
    )).toBe('frozen');
    expect(hardAssignmentMode(
      { NODE_ENV: 'test', HX_HARD_ASSIGNMENT_MODE: 'frozen' },
      { isolatedTestRunner: true },
    )).toBe('frozen');
  });

  it('returns one stable denial contract for every binding lane', () => {
    const lanes: HardAssignmentLane[] = [
      'instant_accept',
      'mutual_consent_accept',
      'poster_assignment',
      'engine_reservation',
      'service_business_assignment',
      'squad_task_accept',
      'squad_task_start',
      'repository_assignment',
    ];
    for (const lane of lanes) {
      const failure = hardAssignmentFailure(lane, {
        NODE_ENV: 'production',
        HX_HARD_ASSIGNMENT_MODE: 'enabled',
      });
      expect(failure).toMatchObject({
        success: false,
        error: {
          code: HARD_ASSIGNMENT_FROZEN_CODE,
          details: { lane, authority: HARD_ASSIGNMENT_FROZEN_AUTHORITY },
        },
      });
    }
    expect(hardAssignmentHealth({ NODE_ENV: 'production' })).toEqual({
      mode: 'frozen',
      acceptsHardAssignment: false,
      authority: HARD_ASSIGNMENT_FROZEN_AUTHORITY,
    });
  });

  it('guards every active application binding path before it can mutate authority', () => {
    const contracts: Array<{ path: string; pattern: RegExp }> = [
      {
        path: 'backend/src/routers/TaskAcceptProcedures.ts',
        pattern: /requireHardAssignment\('mutual_consent_accept'\)[\s\S]*?worker_id = \$2[\s\S]*?requireHardAssignment\('instant_accept'\)[\s\S]*?TaskService\.accept/u,
      },
      {
        path: 'backend/src/routers/TaskAssignmentProcedures.ts',
        pattern: /async function assignWorker[\s\S]*?hardAssignmentFailure\('poster_assignment'\)[\s\S]*?db\.transaction[\s\S]*?commitAssignment/u,
      },
      {
        path: 'backend/src/routers/assignment.ts',
        pattern: /hardAssignmentFailure\('engine_reservation'\)[\s\S]*?TaskReservationService\.reserve/u,
      },
      {
        path: 'backend/src/routers/instant.ts',
        pattern: /hardAssignmentFailure\('instant_accept'\)[\s\S]*?TaskService\.accept/u,
      },
      {
        path: 'backend/src/routers/squadTaskParticipationRoutes.ts',
        pattern: /requireHardAssignment\('squad_task_start'\)[\s\S]*?status = 'in_progress'[\s\S]*?requireHardAssignment\('squad_task_accept'\)[\s\S]*?INSERT INTO squad_task_workers/u,
      },
      {
        path: 'backend/src/services/TaskAcceptService.ts',
        pattern: /async function accept[\s\S]*?hardAssignmentFailure\('instant_accept'\)[\s\S]*?db\.transaction/u,
      },
      {
        path: 'backend/src/services/TaskReservationService.ts',
        pattern: /reserve: async[\s\S]*?hardAssignmentFailure\([\s\S]*?if \(frozen\) return frozen;[\s\S]*?db\.transaction/u,
      },
      {
        path: 'backend/src/services/TaskReservationRepository.ts',
        pattern: /function commitReservation[\s\S]*?hardAssignmentFailure\([\s\S]*?if \(frozen\)[\s\S]*?commit_service_business_task_assignment[\s\S]*?worker_id=\$2/u,
      },
      {
        path: 'backend/src/services/ServiceBusinessExecutionService.ts',
        pattern: /acceptServiceBusinessOpportunity[\s\S]*?hardAssignmentFailure\('service_business_assignment'\)[\s\S]*?TaskReservationService\.reserve/u,
      },
      {
        path: 'backend/src/repositories/TaskRepository.ts',
        pattern: /async updateState[\s\S]*?newState === 'ACCEPTED'[\s\S]*?requireRepositoryAssignment\(\)[\s\S]*?async assignWorker[\s\S]*?requireRepositoryAssignment\(\)[\s\S]*?worker_id = \$1/u,
      },
    ];

    for (const contract of contracts) {
      expect(readSource(contract.path), contract.path).toMatch(contract.pattern);
    }
  });

  it('keeps direct SQL binding blocked below the application layer', () => {
    const sql = readSource(
      'backend/database/migrations/20260827_universal_v1_lifecycle_contract.sql',
    );
    expect(sql).toContain('is_hustlexp_disposable_assignment_ci');
    expect(sql).toContain("current_user = 'hx_ci_runner'");
    for (const database of [
      'hx_ci_invariant_test',
      'hx_ci_system_test',
      'hx_ci_fresh_test',
      'hx_ci_upgrade_test',
    ]) {
      expect(sql).toContain(`'${database}'`);
    }
    expect(sql).toContain(
      'hard assignment is denied outside the exact disposable CI database identity',
    );
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON tasks');
    expect(sql).not.toContain(
      'BEFORE INSERT OR UPDATE OF universal_contract_version, worker_id ON tasks',
    );
    expect(sql).toContain('BEFORE INSERT ON squad_task_workers');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF status ON squad_task_assignments');
    expect(sql).toContain("NEW.status IN ('ready', 'in_progress')");
    expect(sql).toContain('REVOKE ALL ON FUNCTION is_hustlexp_disposable_assignment_ci()');
  });
});
