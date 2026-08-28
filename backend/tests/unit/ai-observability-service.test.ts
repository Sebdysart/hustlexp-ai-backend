import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  readQuery: vi.fn(),
  transaction: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: mocks.query,
    readQuery: mocks.readQuery,
    transaction: mocks.transaction,
  },
}));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ error: mocks.error }) },
}));

import {
  AIObservabilityService,
  aiObservationHash,
} from '../../src/services/AIObservabilityService.js';
import {
  AI_OBSERVABILITY_CONTRACTS,
  aiObservation,
} from '../../src/services/AIObservabilityPolicy.js';

const observationId = '11111111-1111-4111-8111-111111111111';
const actorUserId = '22222222-2222-4222-8222-222222222222';

const context = aiObservation('AI-SCOPER-PROPOSAL', {
  actorUserId,
  affectedObjectType: 'TASK_DRAFT',
  affectedObjectId: 'draft-1',
});

const row = {
  id: observationId,
  surface_id: context.surfaceId,
  affected_object_type: context.affectedObjectType,
  affected_object_id: context.affectedObjectId,
  action: context.action,
  scope_affected: context.scopeAffected,
  reason: context.reason,
  evidence_classes: [...context.evidenceClasses],
  expected_benefit: context.expectedBenefit,
  uncertainty: context.uncertainty,
  downside: context.downside,
  authority_level: context.authorityLevel,
  policy_version: context.policyVersion,
  provider: 'groq',
  model_version: 'llama-test',
  confidence_band: context.confidenceBand,
  controls: context.controls,
  outcome_source: context.outcomeSource,
  execution_result: 'GENERATED' as const,
  latency_ms: 125,
  occurred_at: new Date('2026-07-21T12:00:00.000Z'),
  recorded_at: new Date('2026-07-21T12:00:00.100Z'),
};

describe('AI observability policy', () => {
  it('defines a non-executing, reversible, explainable contract for every inventoried surface', () => {
    expect(Object.keys(AI_OBSERVABILITY_CONTRACTS)).toHaveLength(16);
    for (const [surfaceId, contract] of Object.entries(AI_OBSERVABILITY_CONTRACTS)) {
      expect(contract.surfaceId).toBe(surfaceId);
      expect(contract.reason.length).toBeGreaterThan(0);
      expect(contract.evidenceClasses.length).toBeGreaterThan(0);
      expect(contract.uncertainty.length).toBeGreaterThan(0);
      expect(contract.downside.length).toBeGreaterThan(0);
      expect(contract.controls).toMatchObject({
        why: true,
        autoExecute: false,
        reversible: true,
      });
      expect(['A2_PROPOSAL_ONLY', 'INFORMATIONAL_ONLY']).toContain(contract.authorityLevel);
    }
  });

  it('normalizes unbound object identifiers instead of persisting raw input', () => {
    const normalized = aiObservation('AI-INCIDENT-DIAGNOSIS', {
      affectedObjectType: ' incident ',
      affectedObjectId: '   ',
    });
    expect(normalized.actorUserId).toBeNull();
    expect(normalized.affectedObjectType).toBe('incident');
    expect(normalized.affectedObjectId).toBe('UNBOUND');
  });
});

describe('AIObservabilityService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hashes normalized evidence deterministically', () => {
    expect(aiObservationHash({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(aiObservationHash({ a: { x: 1, y: 2 }, b: 2 }));
  });

  it('stores a hash instead of raw model output and returns the disclosure receipt', async () => {
    mocks.query.mockResolvedValue({ rows: [row], rowCount: 1 });
    const secretOutput = 'private model output that must never be stored';

    const result = await AIObservabilityService.record({
      context,
      provider: 'groq',
      modelVersion: 'llama-test',
      executionResult: 'GENERATED',
      output: secretOutput,
      latencyMs: 125,
      occurredAt: '2026-07-21T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        observationId,
        surfaceId: 'AI-SCOPER-PROPOSAL',
        modelVersion: 'llama-test',
        policyVersion: 'hxos-scoper-proposal-v1',
        executionResult: 'GENERATED',
      },
    });
    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('output_hash');
    expect(sql).not.toContain('raw_output');
    expect(values).not.toContain(secretOutput);
    expect(values[19]).toBe(aiObservationHash(secretOutput));
  });

  it('fails closed when the immutable evidence write fails', async () => {
    mocks.query.mockRejectedValue(new Error('database unavailable'));
    await expect(AIObservabilityService.record({
      context,
      provider: 'groq',
      modelVersion: 'llama-test',
      executionResult: 'GENERATED',
      output: '{}',
      latencyMs: 10,
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'AI_OBSERVABILITY_REQUIRED' },
    });
  });

  it('rejects an altered outcome replay', async () => {
    mocks.query.mockResolvedValue({
      rows: [{ id: 'outcome-1', payload_hash: 'f'.repeat(64), inserted: false }],
      rowCount: 1,
    });
    await expect(AIObservabilityService.recordOutcome({
      observationId,
      outcomeType: 'PROPOSAL_VALIDATED',
      outcomeObjectType: 'TASK_DRAFT',
      outcomeObjectId: 'draft-1',
      realizedResult: { valid: true },
      sourceTable: 'scoper_ai_service',
      sourceEventId: 'draft-1:validated',
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('does not let one user respond to another user\'s scope proposal', async () => {
    mocks.readQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(AIObservabilityService.recordUserResponse({
      observationId,
      actorUserId: '33333333-3333-4333-8333-333333333333',
      action: 'ACCEPTED',
      editedFields: [],
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'AI_OBSERVATION_NOT_FOUND' },
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('records a neutral, reversible user response without automatic state or rank changes', async () => {
    mocks.readQuery.mockResolvedValue({ rows: [{ id: observationId }], rowCount: 1 });
    mocks.query.mockResolvedValue({
      rows: [{ id: 'outcome-1', payload_hash: '', inserted: true }],
      rowCount: 1,
    });
    const result = await AIObservabilityService.recordUserResponse({
      observationId,
      actorUserId,
      action: 'EDITED',
      editedFields: ['duration', 'tools', 'duration'],
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    });
    expect(result).toEqual({ success: true, data: { outcomeId: 'outcome-1' } });
    const values = mocks.query.mock.calls[0]?.[1] as unknown[];
    expect(values[1]).toBe('USER_EDITED');
    expect(JSON.parse(String(values[4]))).toEqual({
      userAction: 'EDITED',
      editedFields: ['duration', 'tools'],
      automaticStateChange: false,
      rankingPenalty: 0,
    });
  });

  it('purpose-logs operator detail access and returns realized outcomes', async () => {
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'outcome-1', outcome_type: 'TASK_CREATED' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mocks.transaction.mockImplementation(async (callback: (query: typeof txQuery) => unknown) => callback(txQuery));

    const result = await AIObservabilityService.getDetail(
      observationId,
      'Investigate a disputed scope recommendation',
      '55555555-5555-4555-8555-555555555555',
    );

    expect(result).toMatchObject({
      observationId,
      outcomes: [{ id: 'outcome-1', outcome_type: 'TASK_CREATED' }],
      operatorAccessRecorded: true,
    });
    expect(txQuery).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO ai_observation_access_log'),
      [
        observationId,
        '55555555-5555-4555-8555-555555555555',
        'Investigate a disputed scope recommendation',
      ],
    );
  });
});
