/**
 * Maintenance Worker — cancel_stale_escrows
 *
 * Verifies the auto-refund of FUNDED-but-unaccepted escrows (truth-table row 37):
 * refund issued per escrow, poster notified, fail-closed retry on Stripe failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  workerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/services/EscrowService.js', () => ({
  EscrowService: { refund: vi.fn() },
}));

vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: { createNotification: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
}));

import { db } from '../../src/db';
import { processMaintenanceJob } from '../../src/jobs/maintenance-worker';
import { EscrowService } from '../../src/services/EscrowService.js';
import { NotificationService } from '../../src/services/NotificationService.js';
import { notifyAdmins } from '../../src/services/AdminNotificationHelper.js';

const mockDb = vi.mocked(db);
const mockRefund = vi.mocked(EscrowService.refund);
const mockNotify = vi.mocked(NotificationService.createNotification);
const mockNotifyAdmins = vi.mocked(notifyAdmins);

const job = (data: Record<string, unknown> = {}) => ({ name: 'cancel_stale_escrows', data } as never);
const reconcileJob = (data: Record<string, unknown> = {}) => ({ name: 'reconcile_ledger', data } as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('maintenance: cancel_stale_escrows', () => {
  it('refunds each stale unaccepted escrow and notifies the poster', async () => {
    mockDb.query.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        { id: 'esc-1', poster_id: 'poster-1', task_id: 'task-1' },
        { id: 'esc-2', poster_id: 'poster-2', task_id: 'task-2' },
      ],
    } as never);
    mockRefund.mockResolvedValue({ success: true, data: { id: 'esc', state: 'REFUNDED' } } as never);

    await processMaintenanceJob(job({ staleHours: 72 }));

    expect(mockRefund).toHaveBeenCalledTimes(2);
    expect(mockRefund).toHaveBeenCalledWith({ escrowId: 'esc-1' });
    expect(mockRefund).toHaveBeenCalledWith({ escrowId: 'esc-2' });
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'poster-1', category: 'refund_issued', taskId: 'task-1' }));
  });

  it('is a no-op when there are no stale escrows', async () => {
    mockDb.query.mockResolvedValueOnce({ rowCount: 0, rows: [] } as never);

    await processMaintenanceJob(job());

    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('fails closed: a failed refund is logged, does not notify, and does not throw', async () => {
    mockDb.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'esc-1', poster_id: 'poster-1', task_id: 'task-1' }],
    } as never);
    mockRefund.mockResolvedValueOnce({ success: false, error: { code: 'STRIPE_REFUND_FAILED', message: 'card error' } } as never);

    await expect(processMaintenanceJob(job())).resolves.toBeUndefined();
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('defaults staleHours to 72 when not provided (passes it to the query)', async () => {
    mockDb.query.mockResolvedValueOnce({ rowCount: 0, rows: [] } as never);

    await processMaintenanceJob(job());

    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("state = 'FUNDED'"), [72]);
  });
});

describe('maintenance: reconcile_ledger', () => {
  it('is clean (no admin alert) when there is no drift', async () => {
    mockDb.query.mockResolvedValueOnce({ rowCount: 0, rows: [] } as never); // missing-refund drift
    mockDb.query.mockResolvedValueOnce({ rowCount: 0, rows: [] } as never); // missing-revenue drift

    await processMaintenanceJob(reconcileJob({ windowDays: 7 }));

    expect(mockNotifyAdmins).not.toHaveBeenCalled();
  });

  it('alerts admins (CRITICAL) when refund or revenue drift is found', async () => {
    mockDb.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'esc-1', task_id: 't-1' }] } as never); // REFUNDED w/o refund id
    mockDb.query.mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 'esc-2', task_id: 't-2' }, { id: 'esc-3', task_id: 't-3' }] } as never); // RELEASED w/o platform_fee

    await processMaintenanceJob(reconcileJob());

    expect(mockNotifyAdmins).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'CRITICAL',
      metadata: expect.objectContaining({ refundDrift: 1, revenueDrift: 2 }),
    }));
  });
});
