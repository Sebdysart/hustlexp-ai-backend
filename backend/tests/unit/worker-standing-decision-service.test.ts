import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ outbox: vi.fn() }));
vi.mock('../../src/lib/outbox-helpers.js', () => ({ writeToOutbox: mocks.outbox }));

import { issueDeactivationAppealRight } from '../../src/services/WorkerStandingDecisionService.js';

describe('WorkerStandingDecisionService', () => {
  beforeEach(() => {
    mocks.outbox.mockReset();
    mocks.outbox.mockResolvedValue({ id: 'outbox-1', idempotencyKey: 'notice-1' });
  });

  it('stores only a digest in the standing-access table while queuing the opaque appeal path before lockout', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'decision-1', appeal_deadline_at: '2026-08-20T00:00:00.000Z' }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await issueDeactivationAppealRight({
      query, workerId: 'worker-1', currentTier: 2, decidedBy: 'admin-1',
      decisionSource: 'ADMIN', reason: 'Confirmed repeated account policy violations.',
      sourceIdempotencyKey: 'admin-ban:event-1',
    });
    expect(result.newlyIssued).toBe(true);
    expect(result.appealPath).toMatch(/^\/earn\/appeal\/[A-Za-z0-9_-]{40,}$/);
    const tokenHash = query.mock.calls[1]?.[1]?.[1];
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.appealPath).not.toContain(tokenHash);
    expect(mocks.outbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'worker.standing_decision_notice',
        payload: expect.objectContaining({
          appealPath: result.appealPath,
          deliveryTruth: 'QUEUED_NOT_DELIVERED',
        }),
      }),
      query,
    );
  });

  it('recovers an idempotent replay without minting a second unusable link', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'decision-1', appeal_deadline_at: '2026-08-20T00:00:00.000Z' }] });
    const result = await issueDeactivationAppealRight({
      query, workerId: 'worker-1', currentTier: 2, decidedBy: null,
      decisionSource: 'SYSTEM', reason: 'System safety deactivation.',
      sourceIdempotencyKey: 'system-ban:event-1',
    });
    expect(result).toMatchObject({ decisionId: 'decision-1', appealPath: null, newlyIssued: false });
    expect(mocks.outbox).not.toHaveBeenCalled();
  });
});
