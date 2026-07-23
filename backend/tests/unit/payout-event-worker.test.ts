import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  workerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { verifyJobSignature, syncProviderPayoutEvent, createNotification } = vi.hoisted(() => ({
  verifyJobSignature: vi.fn(() => true),
  syncProviderPayoutEvent: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('../../src/jobs/queues.js', () => ({ verifyJobSignature }));
vi.mock('../../src/services/HustlerWalletService.js', () => ({
  HustlerWalletService: { syncProviderPayoutEvent },
}));
vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: { createNotification },
}));

import { db } from '../../src/db';
import { processPayoutEventJob } from '../../src/jobs/payout-event-worker';

const mockDb = vi.mocked(db);

function makeJob(type = 'payout.paid'): Job {
  return {
    id: 'job-1',
    data: {
      payload: { stripeEventId: 'evt_test_123', type, _sig: 'test-sig' },
    },
  } as Job;
}

function claim(type: string, payout: Record<string, unknown>, account = 'acct_worker') {
  mockDb.query.mockResolvedValueOnce({
    rows: [{
      type,
      payload_json: { account, data: { object: payout } },
    }],
    rowCount: 1,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyJobSignature.mockReturnValue(true);
  syncProviderPayoutEvent.mockResolvedValue({ matched: true, workerId: 'worker-1' });
  createNotification.mockResolvedValue({ success: true });
});

describe('payout event worker', () => {
  it('rejects unsigned jobs before claiming financial state', async () => {
    const job = { data: { payload: { stripeEventId: 'evt_test_123', type: 'payout.paid' } } } as Job;
    await expect(processPayoutEventJob(job)).rejects.toThrow('JOB_SIGNATURE_INVALID');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('no-ops when another worker already claimed the provider event', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(processPayoutEventJob(makeJob())).resolves.toBeUndefined();
    expect(syncProviderPayoutEvent).not.toHaveBeenCalled();
  });

  it('records provider-paid evidence and notifies the Hustler', async () => {
    const payout = {
      id: 'po_paid', amount: 5000, status: 'paid', arrival_date: 1784462400,
      metadata: { connect_account_id: 'acct_worker', wallet_request_id: 'req-1' },
    };
    claim('payout.paid', payout);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await processPayoutEventJob(makeJob('payout.paid'));

    expect(syncProviderPayoutEvent).toHaveBeenCalledWith(expect.objectContaining({
      stripeEventId: 'evt_test_123',
      providerPayoutId: 'po_paid',
      state: 'paid',
      accountId: 'acct_worker',
      requestId: 'req-1',
      amountCents: 5000,
    }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'worker-1', category: 'payment_released',
      body: expect.stringMatching(/provider-backed receipt/i),
      objectRef: { type: 'payout', id: 'po_paid' },
    }));
  });

  it('records a replay-safe failed-payout audit and recovery notification', async () => {
    const payout = {
      id: 'po_failed', amount: 5000, status: 'failed', failure_code: 'account_closed',
      failure_message: 'Account closed',
      metadata: { connect_account_id: 'acct_worker', wallet_request_id: 'req-1' },
    };
    claim('payout.failed', payout);
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await processPayoutEventJob(makeJob('payout.failed'));

    const auditInsert = mockDb.query.mock.calls.find(([sql]) => (
      typeof sql === 'string' && sql.includes("VALUES ('failed_payout'")
    ));
    expect(auditInsert?.[0]).toContain('ON CONFLICT (stripe_event_id) DO NOTHING');
    expect(auditInsert?.[1]).toEqual(expect.arrayContaining([
      'worker-1', -5000, 'evt_test_123',
    ]));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'worker-1', category: 'payout_failed',
      body: expect.stringMatching(/returns failed payout funds/i),
      objectRef: { type: 'payout', id: 'po_failed' },
    }));
  });

  it('maps in-transit updates without claiming bank receipt', async () => {
    const payout = {
      id: 'po_transit', amount: 5000, status: 'in_transit',
      metadata: { connect_account_id: 'acct_worker', wallet_request_id: 'req-1' },
    };
    claim('payout.updated', payout);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await processPayoutEventJob(makeJob('payout.updated'));

    expect(syncProviderPayoutEvent).toHaveBeenCalledWith(expect.objectContaining({
      state: 'provider_processing',
    }));
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('releases the claim for retry when provider synchronization fails', async () => {
    claim('payout.paid', { id: 'po_paid', amount: 5000, status: 'paid' });
    syncProviderPayoutEvent.mockRejectedValue(new Error('database unavailable'));
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await expect(processPayoutEventJob(makeJob())).rejects.toThrow('database unavailable');
    const release = mockDb.query.mock.calls.find(([sql]) => (
      typeof sql === 'string' && sql.includes("claimed_at=NULL")
    ));
    expect(release?.[1]).toEqual(['evt_test_123', 'database unavailable']);
  });
});
