import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));

import { db } from '../../src/db';
import {
  loadCategoryPerformance,
  loadPreferredWorkOpportunities,
} from '../../src/services/HustlerWalletGrowthData';

const mockDb = vi.mocked(db);

beforeEach(() => vi.clearAllMocks());

describe('Hustler wallet growth evidence', () => {
  it('maps only server-verified category performance and preserves unknown rates', async () => {
    mockDb.query.mockResolvedValue({
      rows: [{
        category: 'assembly', region_code: 'US-WA', verified_assignments: '2',
        verified_completions: '2', completion_rate: '1',
        proof_completeness_rate: null, dispute_rate: '0',
        repeat_customer_count: '1', transaction_review_count: '0',
        weighted_overall_rating: null, experience_band: 'BUILDING_HISTORY',
      }], rowCount: 1,
    } as never);

    const result = await loadCategoryPerformance('worker-private');

    expect(result).toEqual([expect.objectContaining({
      category: 'assembly', verifiedAssignments: 2, verifiedCompletions: 2,
      completionRatePercent: 100, proofCompletenessPercent: null,
      disputeRatePercent: 0, weightedOverallRating: null,
      evidenceLabel: 'verified_production_transactions',
    })]);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE provider_user_id=$1'),
      ['worker-private'],
    );
  });

  it('returns only unfunded preferred rebooks and active recurring reservations for this worker', async () => {
    mockDb.query.mockResolvedValue({
      rows: [{
        opportunity_id: 'reservation-1', opportunity_kind: 'RECURRING_ROUTE',
        task_id: 'task-2', title: 'Weekly lobby reset', category: 'cleaning',
        payout_cents: 6_400, scheduled_for: '2026-07-26T16:00:00.000Z',
        offered_at: '2026-07-19T12:00:00.000Z',
        expires_at: '2026-07-19T12:30:00.000Z',
        opportunity_state: 'RESERVATION_PENDING',
      }], rowCount: 1,
    } as never);

    const result = await loadPreferredWorkOpportunities('worker-private');

    expect(result[0]).toMatchObject({
      id: 'recurring_route:reservation-1', kind: 'recurring_route',
      taskId: 'task-2', state: 'reservation_pending', payoutCents: 6_400,
    });
    const [sql, values] = mockDb.query.mock.calls[0];
    expect(sql).toContain('task.preferred_worker_id=$1');
    expect(sql).toContain('reservation.worker_id=$1');
    expect(sql).toContain("reservation.status='PENDING'");
    expect(sql).toContain('reservation.expires_at>NOW()');
    expect(sql).toContain("task.worker_id IS NULL");
    expect(values).toEqual(['worker-private']);
  });

  it('returns truthful empty arrays when no verified history or preferred work exists', async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await expect(loadCategoryPerformance('worker-new')).resolves.toEqual([]);
    await expect(loadPreferredWorkOpportunities('worker-new')).resolves.toEqual([]);
  });
});
