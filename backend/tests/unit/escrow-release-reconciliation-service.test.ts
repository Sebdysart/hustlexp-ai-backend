import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  insurance: vi.fn(),
  earnings: vi.fn(),
  tax: vi.fn(),
  xp: vi.fn(),
  progress: vi.fn(),
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

import { EscrowReleaseReconciliationService } from '../../src/services/EscrowReleaseReconciliationService.js';

function releasedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'escrow-1', task_id: 'task-1', state: 'RELEASED', amount: 5000,
    platform_fee_cents: 1000, stripe_transfer_id: 'tr_exact',
    worker_id: 'worker-1', payment_method: 'escrow', ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insurance.mockResolvedValue({ success: true, data: undefined });
  mocks.earnings.mockResolvedValue({ success: true, data: undefined });
  mocks.tax.mockResolvedValue({ success: true, data: undefined });
  mocks.xp.mockResolvedValue({ success: true, data: { id: 'xp-1' } });
  mocks.progress.mockResolvedValue({ success: true, data: { id: 'task-1', progress_state: 'CLOSED' } });
});

describe('EscrowReleaseReconciliationService', () => {
  it('reconciles the exact 5000 = 1000 fee + 100 insurance + 3900 worker accounting', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

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
    expect(String(mocks.query.mock.calls[1][0])).toContain('ON CONFLICT (idempotency_key)');
  });

  it('treats an existing XP award as idempotent success', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [releasedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
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
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
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
});
