import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compliance: vi.fn(),
  resolvePolicy: vi.fn(),
  evaluatePolicy: vi.fn(),
  validate: vi.fn(),
  sanitize: vi.fn(),
  buildScope: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({ db: { transaction: vi.fn() } }));
vi.mock('../../src/services/AnalyticsService.js', () => ({ AnalyticsService: { track: vi.fn() } }));

vi.mock('../../src/services/ComplianceGuardianService.js', () => ({
  ComplianceGuardianService: { evaluate: mocks.compliance },
}));
vi.mock('../../src/services/RegionPolicyService.js', () => ({
  resolveRegionPolicy: mocks.resolvePolicy,
  evaluateTaskAgainstRegionPolicy: mocks.evaluatePolicy,
}));
vi.mock('../../src/services/taskIntake/validateIntake.js', () => ({ validateTaskIntake: mocks.validate }));
vi.mock('../../src/services/taskIntake/sanitizeIntakeAnswers.js', () => ({ sanitizeIntakeAnswers: mocks.sanitize }));
vi.mock('../../src/services/taskIntake/buildScopeSummary.js', () => ({ buildTaskScopeSummary: mocks.buildScope }));
vi.mock('../../src/services/ManualTaskRisk.js', () => ({ deriveManualTaskRisk: () => 'LOW' }));

import {
  createCanonicalTaskDraftInTransaction,
  type CanonicalTaskDraftInput,
} from '../../src/services/CanonicalTaskDraftService.js';

const input: CanonicalTaskDraftInput = {
  lead: {
    submission_id: '11111111-1111-4111-8111-111111111111',
    lead_type: 'poster',
    email: 'customer@example.com',
    name: 'Customer',
    answers: {}, utm: {}, consent_version: 'v1',
  },
  task: {
    category: 'other', title: 'Move a large item', raw_input: 'Move a large item downstairs',
    structured: {}, photo_count: 0, source: 'website', utm: {},
  },
};

describe('canonical task draft creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compliance.mockResolvedValue({ tier: 'allow' });
    mocks.resolvePolicy.mockResolvedValue({ id: 'policy' });
    mocks.evaluatePolicy.mockReturnValue({ allowed: true, snapshot: {
      policyId: 'p1', policyVersion: 'v1', policyHash: 'hash',
    } });
    mocks.validate.mockReturnValue({
      readyForDraft: true, missingRequired: [], missingRecommended: [], invalidAnswers: [], quality: 'complete',
    });
    mocks.sanitize.mockReturnValue({});
    mocks.buildScope.mockReturnValue('Move a large item downstairs');
  });

  async function create(posterUserId: string | null, source = 'website') {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT td.lead_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO leads')) return { rows: [{ id: 'lead-1' }], rowCount: 1 };
      if (sql.includes('INSERT INTO task_drafts')) return { rows: [{ id: 'draft-1', quote_id: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const result = await createCanonicalTaskDraftInTransaction(query, {
      input, posterUserId, actorUserId: 'actor-1', source,
    });
    return { calls, result };
  }

  it('keeps ordinary customer ownership on both lead and draft', async () => {
    const { calls } = await create('poster-1');
    expect(calls.find((call) => call.sql.includes('INSERT INTO leads'))?.params?.at(-1)).toBe('poster-1');
    expect(calls.find((call) => call.sql.includes('INSERT INTO task_drafts'))?.params?.at(-1)).toBe('poster-1');
  });

  it('creates an immediately useful ownerless Ops draft without assigning the actor', async () => {
    const { calls, result } = await create(null, 'ops_phone');
    expect(result.taskDraftId).toBe('draft-1');
    expect(calls.find((call) => call.sql.includes('INSERT INTO leads'))?.params?.at(-1)).toBeNull();
    const draftParams = calls.find((call) => call.sql.includes('INSERT INTO task_drafts'))?.params;
    expect(draftParams?.at(-1)).toBeNull();
    expect(draftParams).toContain('ops_phone');
  });

  it('still applies canonical intake validation', async () => {
    mocks.validate.mockReturnValue({
      readyForDraft: false, missingRequired: ['items'], missingRecommended: [], invalidAnswers: [], quality: 'incomplete',
    });
    await expect(create(null, 'ops_phone')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
