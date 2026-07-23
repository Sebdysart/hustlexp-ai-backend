import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  serializable: vi.fn(),
  outbox: vi.fn(),
  evaluatePromotion: vi.fn(),
  redisDel: vi.fn(),
}));
vi.mock('../../src/db.js', () => ({
  db: {
    query: mocks.query,
    transaction: mocks.transaction,
    serializableTransaction: mocks.serializable,
  },
}));
vi.mock('../../src/lib/outbox-helpers.js', () => ({ writeToOutbox: mocks.outbox }));
vi.mock('../../src/services/TrustTierService.js', () => ({
  TrustTier: {
    0: 'EXPLORER', 1: 'VERIFIED', 2: 'HOME_READY', 3: 'PRO', 4: 'LICENSED_SPECIALIST',
    EXPLORER: 0, VERIFIED: 1, HOME_READY: 2, PRO: 3, LICENSED_SPECIALIST: 4, BANNED: 9,
  },
  trustTierName: (tier: number) => ['Explorer', 'Verified', 'Home Ready', 'Pro', 'Licensed Specialist'][tier] ?? 'Unknown',
  TrustTierService: { evaluatePromotion: mocks.evaluatePromotion },
}));
vi.mock('../../src/auth-cache.js', () => ({ authCache: new Map() }));
vi.mock('../../src/cache/redis.js', () => ({ redis: { del: mocks.redisDel } }));

import {
  getDeactivationAppealByToken,
  getMyWorkerStanding,
  openDeactivationAppeal,
  openProgressionAppeal,
  resolveWorkerStandingAppeal,
} from '../../src/services/WorkerStandingAppealService.js';

const decision = {
  id: '11111111-1111-4111-8111-111111111111',
  worker_id: '22222222-2222-4222-8222-222222222222',
  decision_type: 'DEACTIVATION',
  decision_state: 'WORK_ACCESS_DEACTIVATED',
  current_tier: 2,
  target_tier: null,
  reason_codes: ['WORK_ACCESS_DEACTIVATED'],
  public_explanation: 'Your work access was deactivated under the standing policy.',
  policy_version: 'worker-standing-appeals-v1',
  decided_by: '33333333-3333-4333-8333-333333333333',
  appeal_deadline_at: '2026-08-20T00:00:00.000Z',
  created_at: '2026-07-20T00:00:00.000Z',
};
const appeal = {
  id: '44444444-4444-4444-8444-444444444444',
  decision_id: decision.id,
  worker_id: decision.worker_id,
  status: 'OPEN',
  reason: 'The decision relied on an incorrect incident record.',
  request_hash: 'a'.repeat(64),
  idempotency_key: 'appeal-key-1',
  review_due_at: '2026-07-27T00:00:00.000Z',
  assigned_reviewer_id: null,
  resolution_note: null,
  resolved_by: null,
  resolved_at: null,
  opened_at: '2026-07-20T00:00:00.000Z',
  updated_at: '2026-07-20T00:00:00.000Z',
};

describe('WorkerStandingAppealService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (work) => work(mocks.query));
    mocks.serializable.mockImplementation(async (work) => work(mocks.query));
    mocks.outbox.mockResolvedValue({ id: 'outbox-1', idempotencyKey: 'outbox-key' });
    mocks.redisDel.mockResolvedValue(1);
  });

  it('hashes the public credential and returns only minimum decision context', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [decision] })
      .mockResolvedValueOnce({ rows: [] });
    const token = 'A'.repeat(48);
    const result = await getDeactivationAppealByToken(token);
    expect(mocks.query.mock.calls[0]?.[1]?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.query.mock.calls[0]?.[1]?.[0]).not.toBe(token);
    expect(result.decision).toMatchObject({ type: 'DEACTIVATION', rankingPenalty: 0 });
    expect(result).not.toHaveProperty('workerId');
  });

  it('opens one appeal atomically and records an attributable public event', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [decision] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [appeal] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(openDeactivationAppeal({
      token: 'B'.repeat(48), reason: appeal.reason, idempotencyKey: appeal.idempotency_key,
    })).resolves.toMatchObject({ id: appeal.id, status: 'OPEN', rankingPenalty: 0 });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[4]?.[0]).toContain("'OPENED'");
    expect(mocks.outbox).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ appealNarrativeExcluded: true }),
    }), mocks.query);
  });

  it('presents Tier 0 as Explorer and the next evidence-backed unlock as Verified', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false, account_status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.evaluatePromotion.mockResolvedValue({
      eligible: false,
      reasons: ['ID verification required', 'Payout onboarding required'],
    });

    await expect(getMyWorkerStanding(decision.worker_id)).resolves.toMatchObject({
      currentTier: 0,
      currentTierName: 'Explorer',
      targetTier: 1,
      targetTierName: 'Verified',
      canAppealProgression: true,
      progressionExternallyBlocked: false,
    });
  });

  it('refuses a progression appeal when automatic progression is already earned', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ trust_tier: 2, is_banned: false, account_status: 'ACTIVE' }] });
    mocks.evaluatePromotion.mockResolvedValue({ eligible: true, targetTier: 3, reasons: [] });
    await expect(openProgressionAppeal({
      workerId: decision.worker_id,
      reason: 'The progression calculation should be reviewed by a human.',
      idempotencyKey: 'progression-appeal-1',
    })).rejects.toThrow('currently qualify for automatic progression');
  });

  it('does not manufacture an appeal decision for a later-phase progression tier', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ trust_tier: 2, is_banned: false, account_status: 'ACTIVE' }] });
    mocks.evaluatePromotion.mockResolvedValue({
      eligible: false,
      reasons: ['Pro progression is not enabled in the Build-Now release; production evidence is required'],
    });
    await expect(openProgressionAppeal({
      workerId: decision.worker_id,
      reason: 'I want the commercial progression evidence reviewed by a human.',
      idempotencyKey: 'progression-appeal-deferred-1',
    })).rejects.toThrow('not enabled in the Build-Now release');
  });

  it('rejects the original decision maker as the appeal reviewer', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      ...appeal,
      ...decision,
      id: appeal.id,
      decision_id: decision.id,
      worker_id: decision.worker_id,
      status: 'OPEN',
      firebase_uid: 'firebase-worker',
      trust_tier: 2,
      is_banned: true,
    }] });
    await expect(resolveWorkerStandingAppeal({
      appealId: appeal.id,
      reviewerId: decision.decided_by,
      decision: 'OVERTURNED',
      resolutionNote: 'The original decision used an incorrect source record.',
      idempotencyKey: 'resolve-appeal-1',
    })).rejects.toThrow('different human reviewer');
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it('does not let an overturned progression appeal bypass authoritative evidence', async () => {
    const reviewer = '55555555-5555-4555-8555-555555555555';
    mocks.query.mockResolvedValueOnce({ rows: [{
      ...appeal,
      ...decision,
      id: appeal.id,
      decision_id: decision.id,
      worker_id: decision.worker_id,
      decision_type: 'PROGRESSION',
      current_tier: 0,
      target_tier: 1,
      status: 'OPEN',
      firebase_uid: 'firebase-worker',
      trust_tier: 0,
      is_banned: false,
    }] });
    mocks.evaluatePromotion.mockResolvedValue({
      eligible: false,
      reasons: ['Payout onboarding required'],
    });

    await expect(resolveWorkerStandingAppeal({
      appealId: appeal.id,
      reviewerId: reviewer,
      decision: 'OVERTURNED',
      resolutionNote: 'The submitted evidence requires correction before progression.',
      idempotencyKey: 'resolve-progression-no-bypass-1',
    })).rejects.toThrow('Authoritative evidence still does not support progression');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE users SET trust_tier'))).toBe(false);
  });

  it('overturns a deactivation and clears only the matching revocation marker', async () => {
    const reviewer = '55555555-5555-4555-8555-555555555555';
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        ...appeal,
        ...decision,
        id: appeal.id,
        decision_id: decision.id,
        worker_id: decision.worker_id,
        status: 'OPEN',
        firebase_uid: 'firebase-worker',
        trust_tier: 2,
        is_banned: true,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: appeal.id, status: 'OVERTURNED', resolved_at: 'now' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(resolveWorkerStandingAppeal({
      appealId: appeal.id,
      reviewerId: reviewer,
      decision: 'OVERTURNED',
      resolutionNote: 'Independent evidence proved the standing decision was incorrect.',
      idempotencyKey: 'resolve-appeal-2',
    })).resolves.toEqual({ appealId: appeal.id, status: 'OVERTURNED', effectApplied: true });
    expect(mocks.query.mock.calls[1]?.[0]).toContain('is_banned=FALSE');
    expect(mocks.redisDel).toHaveBeenCalledWith('auth:revoked:firebase-worker');
  });
});
