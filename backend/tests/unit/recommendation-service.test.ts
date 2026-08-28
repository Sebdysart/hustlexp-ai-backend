import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({
  db: { transaction: vi.fn(), query: vi.fn() },
}));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import { db } from '../../src/db.js';
import { recommendationRequestHash } from '../../src/services/RecommendationPolicy.js';
import { RecommendationService } from '../../src/services/RecommendationService.js';

const mockDb = vi.mocked(db);
const recommendation = {
  recipientUserId: '11111111-1111-4111-8111-111111111111',
  subjectType: 'TASK' as const,
  subjectId: '22222222-2222-4222-8222-222222222222',
  recommendationClass: 'ECONOMIC' as const,
  sourceType: 'AI' as const,
  recommendationText: 'Review this nearby fence task.',
  reason: 'Your verified outdoor capability and travel radius fit.',
  evidenceClasses: ['VERIFIED_SKILLS', 'DISTANCE', 'MATCH_SCORE'] as const,
  expectedBenefit: 'Find qualified work within the selected travel range.',
  downside: 'Fit is an estimate; review exact economics and scope.',
  confidenceBand: 'LIKELY' as const,
  modelVersion: 'groq:model-v1',
  policyVersion: 'hxos-task-suggestion-v1',
  scopeAffected: 'task_discovery_order',
  userControls: { open: true, edit: false, dismiss: true, snooze: true, why: true, autoExecute: false },
  aiObservationId: '44444444-4444-4444-8444-444444444444',
  idempotencyKey: 'suggestion:session-1:task-1',
  expiresAt: '2026-07-20T00:00:00.000Z',
};

describe('RecommendationService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a displayed batch atomically and returns durable IDs', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: '33333333-3333-4333-8333-333333333333', request_hash: 'placeholder' }],
      rowCount: 1,
    });
    mockDb.transaction.mockImplementation(async (callback: any) => callback(query));

    const result = await RecommendationService.recordDisplayedBatch([recommendation]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].recommendationId).toBe('33333333-3333-4333-8333-333333333333');
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO recommendations');
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO recommendation_events');
  });

  it('fails closed when an idempotency key replays with altered content', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: '33333333-3333-4333-8333-333333333333',
        request_hash: 'f'.repeat(64),
        inserted: false,
      }],
      rowCount: 1,
    });
    mockDb.transaction.mockImplementation(async (callback: any) => callback(query));

    const result = await RecommendationService.recordDisplayedBatch([recommendation]);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('records neutral user feedback only for the authenticated recipient', async () => {
    mockDb.query.mockResolvedValue({
      rows: [{ id: 'event-1', ranking_penalty: 0 }], rowCount: 1,
    } as any);

    const result = await RecommendationService.recordUserEvent({
      actorId: recommendation.recipientUserId,
      recommendationId: '33333333-3333-4333-8333-333333333333',
      eventType: 'DISMISSED',
      idempotencyKey: 'dismiss:1',
      publicNote: null,
    });

    expect(result).toEqual({ success: true, data: { eventId: 'event-1', rankingPenalty: 0 } });
    expect(String(mockDb.query.mock.calls[0][0])).toContain('recipient_user_id = $2');
  });

  it('accepts an exact user-event replay and rejects altered replay content', async () => {
    const input = {
      actorId: recommendation.recipientUserId,
      recommendationId: '33333333-3333-4333-8333-333333333333',
      eventType: 'DISMISSED' as const,
      idempotencyKey: 'dismiss:replay',
      publicNote: null,
    };
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'event-1', request_hash: recommendationRequestHash(input),
        ranking_penalty: 0, inserted: false,
      }], rowCount: 1,
    } as any);

    await expect(RecommendationService.recordUserEvent(input)).resolves.toEqual({
      success: true, data: { eventId: 'event-1', rankingPenalty: 0 },
    });

    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'event-1', request_hash: 'f'.repeat(64), ranking_penalty: 0, inserted: false }],
      rowCount: 1,
    } as any);
    await expect(RecommendationService.recordUserEvent(input)).resolves.toMatchObject({
      success: false, error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('records a realized outcome without rewriting the recommendation', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ id: 'outcome-1' }], rowCount: 1 } as any);
    const result = await RecommendationService.recordOutcome({
      recommendationId: '33333333-3333-4333-8333-333333333333',
      outcomeType: 'TASK_COMPLETED',
      sourceObjectId: recommendation.subjectId,
      realizedValue: { completed: true, settled: false },
    });
    expect(result).toEqual({ success: true, data: { outcomeId: 'outcome-1' } });
    expect(String(mockDb.query.mock.calls[0][0])).toContain('INSERT INTO recommendation_outcomes');
  });

  it('accepts an exact outcome replay and rejects altered realized values', async () => {
    const input = {
      recommendationId: '33333333-3333-4333-8333-333333333333',
      outcomeType: 'TASK_COMPLETED' as const,
      sourceObjectId: recommendation.subjectId,
      realizedValue: { taskState: 'COMPLETED', payoutReady: true },
    };
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'outcome-1', request_hash: recommendationRequestHash(input), inserted: false }],
      rowCount: 1,
    } as any);
    await expect(RecommendationService.recordOutcome(input)).resolves.toEqual({
      success: true, data: { outcomeId: 'outcome-1' },
    });

    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'outcome-1', request_hash: 'f'.repeat(64), inserted: false }], rowCount: 1,
    } as any);
    await expect(RecommendationService.recordOutcome(input)).resolves.toMatchObject({
      success: false, error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('fans a sanitized task outcome out to every recommendation for that task', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ conflict_count: '0' }], rowCount: 1 });

    await RecommendationService.recordTaskOutcome(query as any, {
      taskId: recommendation.subjectId,
      outcomeType: 'TASK_COMPLETED',
      realizedValue: { taskState: 'COMPLETED', payoutReady: true },
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain("subject_type = 'TASK'");
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO recommendation_outcomes');
    expect(String(query.mock.calls[1][0])).toContain('request_hash <>');
    expect(query.mock.calls[1][1]).toHaveLength(3);
    expect(String(query.mock.calls[1][0])).not.toContain('$4');
  });

  it('lists only the authenticated recipient\'s unexpired recommendations without audit hashes', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{
      id: '33333333-3333-4333-8333-333333333333',
      subject_type: 'TASK', subject_id: recommendation.subjectId,
      recommendation_class: 'ECONOMIC', source_type: 'AI',
      recommendation_text: recommendation.recommendationText,
      reason: recommendation.reason, evidence_classes: ['VERIFIED_SKILLS'],
      expected_benefit: recommendation.expectedBenefit, downside: recommendation.downside,
      confidence_band: 'LIKELY', model_version: 'groq/model-v1',
      policy_version: 'hxos-task-suggestion-v1', scope_affected: 'task_discovery_order',
      user_controls: recommendation.userControls, autonomy_level: 'RECOMMEND_ONLY',
      displayed_at: new Date('2026-07-19T10:00:00.000Z'),
      expires_at: new Date('2026-07-20T10:00:00.000Z'),
      latest_action: 'SNOOZED', latest_action_at: new Date('2026-07-19T10:05:00.000Z'),
      outcomes: [{ outcomeType: 'TASK_COMPLETED', realizedValue: { taskState: 'COMPLETED' } }],
    }], rowCount: 1 } as any);

    const result = await RecommendationService.listCurrent(recommendation.recipientUserId, {
      limit: 20, offset: 0,
    });

    expect(result).toMatchObject({
      success: true,
      data: [{
        id: '33333333-3333-4333-8333-333333333333',
        subjectType: 'TASK', latestAction: 'SNOOZED', autonomyLevel: 'RECOMMEND_ONLY',
      }],
    });
    const [sql, values] = mockDb.query.mock.calls[0];
    expect(String(sql)).toContain('recipient_user_id=$1 AND expires_at > NOW()');
    expect(String(sql)).not.toContain('request_hash');
    expect(values).toEqual([recommendation.recipientUserId, 20, 0]);
    expect(JSON.stringify(result)).not.toContain('idempotency_key');
  });
});
