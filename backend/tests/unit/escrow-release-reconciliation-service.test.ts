import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  insurance: vi.fn(),
  earnings: vi.fn(),
  tax: vi.fn(),
  xp: vi.fn(),
  progress: vi.fn(),
  revenue: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({ config: { stripe: { platformFeePercent: 20 } } }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution: mocks.insurance },
}));
vi.mock('../../src/services/EarnedVerificationUnlockService.js', () => ({
  EarnedVerificationUnlockService: { recordEarnings: mocks.earnings },
}));
vi.mock('../../src/services/XPTaxService.js', () => ({
  XPTaxService: { recordOfflinePayment: mocks.tax },
}));
vi.mock('../../src/services/XPService.js', () => ({ XPService: { awardXP: mocks.xp } }));
vi.mock('../../src/services/TaskProgressService.js', () => ({
  TaskProgressService: { advanceProgress: mocks.progress },
}));
vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: { logEvent: mocks.revenue },
}));

import { EscrowReleaseReconciliationService } from '../../src/services/EscrowReleaseReconciliationService.js';

function releasedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'escrow-1', task_id: 'task-1', state: 'RELEASED', amount: 5000,
    platform_fee_cents: 1000, stripe_transfer_id: 'tr_exact',
    worker_id: 'worker-1', poster_id: 'poster-1', provider_organization_id: null,
    payment_method: 'escrow', payout_recipient_user_id: 'worker-1',
    payout_provider: 'STRIPE', provider_transfer_id: 'tr_exact',
    provider_transfer_status: 'submitted', ...overrides,
  };
}

function exactReleaseEvent(
  fromState = 'RELEASE_RECONCILIATION',
  overrides: Record<string, unknown> = {},
) {
  return {
    escrow_id: 'escrow-1', from_state: fromState, to_state: 'RELEASED',
    actor_id: null, actor_type: 'system', idempotency_key: 'escrow.released:escrow-1',
    metadata: {
      payout_provider: 'STRIPE', payout_recipient_user_id: 'worker-1',
      provider_transfer_id: 'tr_exact', provider_transfer_status: 'submitted',
    },
    ...overrides,
  };
}

function exactWitnessReadback(overrides: Record<string, unknown> = {}) {
  return {
    release_event: exactReleaseEvent(),
    insurance: {
      task_id: 'task-1', hustler_id: 'worker-1',
      contribution_cents: 100, contribution_percentage: 2,
    },
    earnings: {
      user_id: 'worker-1', task_id: 'task-1', escrow_id: 'escrow-1',
      net_payout_cents: 3900,
    },
    offline_tax: null,
    xp: [{
      user_id: 'worker-1', task_id: 'task-1', escrow_id: 'escrow-1',
      base_xp: 500, effective_xp: 500, reason: 'task_completion',
    }],
    progress_state: 'CLOSED',
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.insurance.mockResolvedValue({ success: true, data: undefined });
  mocks.earnings.mockResolvedValue({ success: true, data: undefined });
  mocks.tax.mockResolvedValue({ success: true, data: undefined });
  mocks.xp.mockResolvedValue({ success: true, data: { id: 'xp-1' } });
  mocks.progress.mockResolvedValue({ success: true, data: { id: 'task-1', progress_state: 'CLOSED' } });
  mocks.revenue.mockResolvedValue({ success: true, data: { id: 'revenue-1' } });
});

describe('EscrowReleaseReconciliationService', () => {
  it('reconciles the exact 5000 = 1000 fee + 100 insurance + 3900 worker accounting', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [exactWitnessReadback({ release_event: exactReleaseEvent('FUNDED') })],
        rowCount: 1,
      });

    const result = await EscrowReleaseReconciliationService.reconcile({
      escrowId: 'escrow-1', expectedStripeTransferId: 'tr_exact', fromState: 'FUNDED',
    });

    expect(result).toEqual({
      success: true,
      data: {
        escrowId: 'escrow-1', taskId: 'task-1', workerId: 'worker-1',
        grossAmountCents: 5000, platformFeeCents: 1000,
        insuranceContributionCents: 100, netPayoutCents: 3900,
      },
    });
    expect(mocks.insurance).toHaveBeenCalledWith('task-1', 'worker-1', 100);
    expect(mocks.earnings).toHaveBeenCalledWith('worker-1', 'task-1', 'escrow-1', 3900);
    expect(mocks.xp).toHaveBeenCalledWith({
      userId: 'worker-1', taskId: 'task-1', escrowId: 'escrow-1', baseXP: 500,
    });
    expect(mocks.progress).toHaveBeenCalledWith({
      taskId: 'task-1', to: 'CLOSED', actor: { type: 'system' },
    });
    expect(mocks.revenue).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'platform_fee', userId: 'poster-1', taskId: 'task-1',
      amountCents: 1000, grossAmountCents: 5000, platformFeeCents: 1000,
      netAmountCents: 4000, escrowId: 'escrow-1', stripeTransferId: 'tr_exact',
    }));
    expect(String(mocks.query.mock.calls[1][0])).toContain('ON CONFLICT (idempotency_key)');
    expect(JSON.parse(String(mocks.query.mock.calls[1][1][2]))).toEqual({
      payout_provider: 'STRIPE', payout_recipient_user_id: 'worker-1',
      provider_transfer_id: 'tr_exact', provider_transfer_status: 'submitted',
    });
    expect(String(mocks.query.mock.calls[3][0])).toContain('FROM escrow_events');
  });

  it('accepts an exact preexisting release event after an idempotency collision', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [exactWitnessReadback()], rowCount: 1 });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: true });
  });

  it.each([
    ['missing', null],
    ['conflicting', exactReleaseEvent('RELEASE_RECONCILIATION', {
      metadata: {
        payout_provider: 'STRIPE', payout_recipient_user_id: 'worker-1',
        provider_transfer_id: 'tr_attacker', provider_transfer_status: 'submitted',
      },
    })],
  ])('fails closed on a %s canonical release-event witness', async (_name, releaseEvent) => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [exactWitnessReadback({ release_event: releaseEvent })], rowCount: 1,
      });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
  });

  it('treats an existing XP award as idempotent success', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [exactWitnessReadback()], rowCount: 1 });
    mocks.xp.mockResolvedValueOnce({
      success: false, error: { code: '23505', message: 'already awarded' },
    });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: true });
  });

  it('fails closed on a different provider transfer before writing witnesses', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 });

    await expect(EscrowReleaseReconciliationService.reconcile({
      escrowId: 'escrow-1', expectedStripeTransferId: 'tr_other',
    })).resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    expect(mocks.insurance).not.toHaveBeenCalled();
    expect(mocks.earnings).not.toHaveBeenCalled();
    expect(mocks.xp).not.toHaveBeenCalled();
  });

  it('returns a retryable failure when a required financial witness cannot be recorded', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.insurance.mockResolvedValueOnce({
      success: false, error: { code: 'RECORD_CONTRIBUTION_FAILED', message: 'db unavailable' },
    });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({
        success: false,
        error: { code: 'RECORD_CONTRIBUTION_FAILED', message: expect.stringContaining('db unavailable') },
      });
    expect(mocks.earnings).not.toHaveBeenCalled();
  });

  it('accepts only an exact immutable platform-fee witness on replay', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: 'revenue-existing', user_id: 'poster-1', task_id: 'task-1',
        amount_cents: 1000, currency: 'usd', gross_amount_cents: 5000,
        platform_fee_cents: 1000, net_amount_cents: 4000,
        escrow_id: 'escrow-1', stripe_transfer_id: 'tr_exact',
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [exactWitnessReadback()], rowCount: 1 });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: true });

    expect(mocks.revenue).not.toHaveBeenCalled();
  });

  it('fails closed when the existing platform-fee witness has different economics', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: 'revenue-wrong', user_id: 'poster-1', task_id: 'task-1',
        amount_cents: 999, currency: 'usd', gross_amount_cents: 5000,
        platform_fee_cents: 999, net_amount_cents: 4001,
        escrow_id: 'escrow-1', stripe_transfer_id: 'tr_exact',
      }], rowCount: 1 });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    expect(mocks.earnings).not.toHaveBeenCalled();
    expect(mocks.progress).not.toHaveBeenCalled();
  });

  it('does not credit personal earnings for a service-business provider', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [releasedRow({ provider_organization_id: 'organization-1' })], rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [exactWitnessReadback({ earnings: null })], rowCount: 1,
      });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: true });

    expect(mocks.earnings).not.toHaveBeenCalled();
    expect(mocks.insurance).toHaveBeenCalled();
    expect(mocks.progress).toHaveBeenCalled();
  });

  it('fails closed when an idempotent financial witness collides with different facts', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [exactWitnessReadback({
          insurance: {
            task_id: 'task-1', hustler_id: 'worker-1',
            contribution_cents: 99, contribution_percentage: 2,
          },
        })],
        rowCount: 1,
      });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
  });

  it('rejects duplicate task-completion XP witnesses instead of accepting a generic collision', async () => {
    const duplicateXp = exactWitnessReadback().xp;
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [exactWitnessReadback({ xp: [...duplicateXp, { ...duplicateXp[0] }] })],
        rowCount: 1,
      });
    mocks.xp.mockResolvedValueOnce({
      success: false, error: { code: '23505', message: 'already awarded' },
    });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
  });

  it('requires absence of platform revenue for a canonical zero-margin release', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [releasedRow({ platform_fee_cents: 0 })], rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'unexpected-fee', user_id: 'poster-1', task_id: 'task-1',
          amount_cents: 1, currency: 'usd', gross_amount_cents: 5000,
          platform_fee_cents: 1, net_amount_cents: 4999,
          escrow_id: 'escrow-1', stripe_transfer_id: 'tr_exact',
        }],
        rowCount: 1,
      });

    await expect(EscrowReleaseReconciliationService.reconcile({ escrowId: 'escrow-1' }))
      .resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    expect(mocks.revenue).not.toHaveBeenCalled();
  });
});
