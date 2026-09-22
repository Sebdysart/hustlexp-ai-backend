import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), local: vi.fn(), localBusiness: vi.fn(),
  binding: vi.fn(), localEnabled: vi.fn(), verifyLocal: vi.fn(), verifyLocalBusiness: vi.fn(), notify: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query,
  transaction: (fn: (q: typeof mocks.query) => unknown) => fn(mocks.query) } }));
vi.mock('../../src/logger.js', () => { const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => log };
  return { logger: log, workerLogger: log }; });
vi.mock('../../src/config.js', () => ({ config: { payments: { platformFeePercent: 15 } } }));
vi.mock('../../src/services/AdminNotificationHelper.js', () => ({ notifyAdmins: vi.fn() }));
vi.mock('../../src/services/EscrowService.js', () => ({ EscrowService: { release: mocks.release } }));
vi.mock('../../src/services/EscrowPaymentBindingService.js', () => ({ loadEscrowPaymentBinding: mocks.binding }));
vi.mock('../../src/services/LocalCertificationPayoutProvider.js', () => ({
  localCertificationPayoutEnabled: mocks.localEnabled,
  LocalCertificationPayoutProvider: { createPaidTransfer: mocks.local, createPaidBusinessTransfer: mocks.localBusiness,
    verifyPaidTransfer: mocks.verifyLocal, verifyPaidBusinessTransfer: mocks.verifyLocalBusiness },
}));
vi.mock('../../src/lib/task-lifecycle-notifications.js', () => ({ notifyPaymentReleased: mocks.notify }));
vi.mock('../../src/services/EscrowReadService.js', () => ({ getEscrowById: vi.fn() }));
vi.mock('../../src/services/EscrowServiceShared.js', () => ({ isTerminalEscrowState: (s: string) => ['RELEASED','REFUNDED','REFUND_PARTIAL'].includes(s) }));

import { processCompletionRelease } from '../../src/jobs/completion-release-orchestrator.js';
import { executeReleaseTransaction } from '../../src/services/EscrowReleaseTransaction.js';

const escrow = { id: 'escrow-1', task_id: 'task-1', state: 'FUNDED', version: 3, amount: 10000, platform_fee_cents: 1500 };
const businessTask = { state: 'COMPLETED', worker_id: null, payout_recipient_user_id: null,
  business_fulfiller_organization_id: 'org-1', orchestration_mode: 'OPS_MANUAL',
  automation_classification: 'PRODUCTION', payment_method: 'escrow', hustler_payout_cents: 8500,
  platform_margin_cents: 1500, poster_id: 'poster-1', provider_organization_id: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.release.mockResolvedValue({ success: true, data: { ...escrow, state: 'RELEASED' } });
  mocks.binding.mockResolvedValue({ provider: 'tilled', status: 'SUCCEEDED', organizationId: 'org-1', taskId: 'task-1' });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM escrows') && sql.includes('FOR UPDATE')) return { rows: [escrow], rowCount: 1 };
    if (sql.includes('FROM tasks')) return { rows: [businessTask], rowCount: 1 };
    if (sql.includes('UPDATE escrows')) return { rows: [{ ...escrow, state: 'RELEASED' }], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
});

describe('merchant-direct task completion', () => {
  it('completes Tilled business bookkeeping without a worker or any payout destination/transfer', async () => {
    await processCompletionRelease({ escrowId: 'escrow-1', taskId: 'task-1' });
    expect(mocks.release).toHaveBeenCalledWith({ escrowId: 'escrow-1' });
    expect(mocks.local).not.toHaveBeenCalled();
    expect(mocks.localBusiness).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.map(([sql]) => sql).join(' ')).not.toContain('payout_destinations');
  });
  it('commits internal RELEASED state with no transfer and no transfer-paid timestamp', async () => {
    const result = await executeReleaseTransaction(mocks.query, { escrowId: 'escrow-1' });
    expect(result.success).toBe(true);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE escrows SET state='RELEASED'"),
      ['escrow-1', 3, 'TILLED', null, 'not_applicable']);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.verifyLocalBusiness).not.toHaveBeenCalled();
  });
  it('uses frozen Tilled task economics even if the default platform fee has changed', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM escrows') && sql.includes('FOR UPDATE')) return { rows: [{ ...escrow, platform_fee_cents: null }], rowCount: 1 };
      if (sql.includes('FROM tasks')) return { rows: [{ ...businessTask, platform_margin_cents: 700, hustler_payout_cents: 9300, worker_id: 'crew-member' }], rowCount: 1 };
      if (sql.includes('UPDATE escrows')) return { rows: [{ ...escrow, state: 'RELEASED' }], rowCount: 1 };
      throw new Error(sql);
    });
    expect(await executeReleaseTransaction(mocks.query, { escrowId: 'escrow-1' }))
      .toMatchObject({ success: true, post: { platformFeeCents: 700, netPayoutCents: 9300, insuranceContributionCents: 0 } });
  });
  it('rejects a mismatched or non-successful payment before release', async () => {
    for (const invalid of [{ status: 'PENDING', organizationId: 'org-1' }, { status: 'SUCCEEDED', organizationId: 'other-org' }]) {
      mocks.binding.mockResolvedValue({ provider: 'tilled', ...invalid });
      const result = await executeReleaseTransaction(mocks.query, { escrowId: 'escrow-1' });
      expect(result.success).toBe(false);
    }
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('UPDATE escrows'))).toBe(false);
  });
  it('keeps a dispute lock until a worker-favor resolution exists', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...escrow, state: 'LOCKED_DISPUTE' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await executeReleaseTransaction(mocks.query, { escrowId: 'escrow-1' }))
      .toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('UPDATE escrows'))).toBe(false);
  });
  it('allows resolved dispute internal bookkeeping without a merchant transfer', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...escrow, state: 'LOCKED_DISPUTE' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ resolved_dispute_id: 'dispute-1' }], rowCount: 1 });
    expect(await executeReleaseTransaction(mocks.query, { escrowId: 'escrow-1' })).toMatchObject({ success: true });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE escrows SET state='RELEASED'"),
      ['escrow-1', 3, 'TILLED', null, 'not_applicable']);
  });
  it('replays an already completed release without creating additional effects', async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...escrow, state: 'RELEASED' }], rowCount: 1 });
    await processCompletionRelease({ escrowId: 'escrow-1', taskId: 'task-1' });
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('does not complete a different task using the escrow', async () => {
    await expect(processCompletionRelease({ escrowId: 'escrow-1', taskId: 'other-task' })).rejects.toThrow('binding mismatch');
  });
  it('retains the local-test business transfer lane only for controlled tasks', async () => {
    mocks.binding.mockResolvedValue({ provider: 'local_test', status: 'SUCCEEDED', organizationId: 'org-1' });
    mocks.localEnabled.mockReturnValue(true);
    mocks.localBusiness.mockResolvedValue({ success: true, data: { transferId: 'test-transfer', amountCents: 8500 } });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM escrows')) return { rows: [escrow], rowCount: 1 };
      if (sql.includes('FROM tasks')) return { rows: [{ ...businessTask, automation_classification: 'CONTROLLED_TEST' }], rowCount: 1 };
      if (sql.includes('payout_destinations')) return { rows: [{ payout_recipient_user_id: 'test-payee' }], rowCount: 1 };
      throw new Error(sql);
    });
    await processCompletionRelease({ escrowId: 'escrow-1', taskId: 'task-1' });
    expect(mocks.localBusiness).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith({ escrowId: 'escrow-1', localTestTransferId: 'test-transfer' });
  });
});
