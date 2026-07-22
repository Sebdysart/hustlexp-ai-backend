import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: { stripe: { secretKey: 'placeholder', platformFeePercent: 15 } },
}));

vi.mock('../../src/db', () => {
  const query = vi.fn();
  return {
    db: {
      query,
      transaction: vi.fn((fn: (txQuery: typeof query) => Promise<unknown>) => fn(query)),
    },
  };
});

vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { db } from '../../src/db';
import { HustlerWalletService } from '../../src/services/HustlerWalletService';
import type { WalletProvider, WalletProviderSnapshot } from '../../src/services/HustlerWalletTypes';

const mockDb = vi.mocked(db);
const now = '2026-07-19T12:00:00.000Z';

function snapshot(overrides: Partial<WalletProviderSnapshot> = {}): WalletProviderSnapshot {
  return {
    accountId: 'acct_worker',
    payoutsEnabled: true,
    disabledReason: null,
    availableCents: 12_000,
    pendingCents: 2_500,
    destination: {
      type: 'bank_account', last4: '4242', label: 'Example Bank',
      providerId: 'ba_123', status: 'verified',
    },
    payouts: [
      {
        providerPayoutId: 'po_pending', amountCents: 3_000, currency: 'usd',
        state: 'provider_processing', estimatedArrivalAt: '2026-07-21T12:00:00.000Z',
        createdAt: now, failureCode: null, failureMessage: null,
      },
      {
        providerPayoutId: 'po_paid', amountCents: 8_000, currency: 'usd',
        state: 'paid', estimatedArrivalAt: now, createdAt: now,
        failureCode: null, failureMessage: null,
      },
    ],
    payoutHistoryComplete: true,
    capturedAt: now,
    ...overrides,
  };
}

function provider(overrides: Partial<WalletProvider> = {}): WalletProvider {
  return {
    isConfigured: () => true,
    getSnapshot: vi.fn(async () => snapshot()),
    createStandardPayout: vi.fn(async () => ({
      providerPayoutId: 'po_new', state: 'submitted',
      estimatedArrivalAt: '2026-07-21T12:00:00.000Z',
      failureCode: null, failureMessage: null,
    })),
    ...overrides,
  };
}

function emptyResult() {
  return { rows: [], rowCount: 0 } as never;
}

function accountResult(accountId: string | null = 'acct_worker') {
  return {
    rows: [{ stripe_connect_id: accountId, minimum_payout_amount_cents: 100 }],
    rowCount: 1,
  } as never;
}

function baseQuery(sql: string) {
  if (sql.includes('FROM users u')) return accountResult();
  if (sql.includes('FROM provider_reputation_public')) return {
    rows: [{
      category: 'moving', region_code: 'US-WA', verified_assignments: '5',
      verified_completions: '4', completion_rate: '0.8',
      proof_completeness_rate: '0.75', dispute_rate: '0.25',
      repeat_customer_count: '2', transaction_review_count: '3',
      weighted_overall_rating: '4.67', experience_band: 'BUILDING_HISTORY',
    }], rowCount: 1,
  };
  if (sql.includes("'PREFERRED_REBOOK'::TEXT")) return {
    rows: [{
      opportunity_id: 'task-repeat', opportunity_kind: 'PREFERRED_REBOOK',
      task_id: 'task-repeat', title: 'Move boxes again', category: 'moving',
      payout_cents: 8_500, scheduled_for: '2026-07-24T12:00:00.000Z',
      offered_at: now, expires_at: null, opportunity_state: 'OPEN',
    }], rowCount: 1,
  };
  if (sql.includes('lifetime_earned_cents')) return {
    rows: [{ lifetime_earned_cents: '8300', adjustments_and_holds_cents: '4150' }], rowCount: 1,
  };
  if (sql.includes('FROM escrows e') && sql.includes('LIMIT 50')) return {
    rows: [{
      escrow_id: 'esc_1', task_id: 'task_1', title: 'Move boxes', category: 'moving',
      escrow_state: 'RELEASED', amount: 10_000, platform_fee_cents: 1_500,
      hustler_payout_cents: 8_500, release_amount: null, refund_amount: null,
      stripe_transfer_id: 'tr_1', occurred_at: now,
    }],
    rowCount: 1,
  };
  if (sql.includes('FROM worker_cash_out_requests')) return emptyResult();
  return emptyResult();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.mockImplementation(async (sql: string) => baseQuery(sql) as never);
});

describe('HustlerWalletService.getOverview', () => {
  it('returns unknown provider balances instead of fabricated zero before setup', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users u')) return accountResult(null);
      return baseQuery(sql) as never;
    });

    const result = await HustlerWalletService.getOverview('worker-1', provider());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.availability.status).toBe('setup_required');
    expect(result.data.balances.availableToCashOutCents).toBeNull();
    expect(result.data.balances.paidOutCents).toBeNull();
    expect(result.data.balances.lifetimeEarnedCents).toBe(8300);
  });

  it('separates provider balances, scheduled payouts, paid history, holds, and task net', async () => {
    const result = await HustlerWalletService.getOverview('worker-1', provider());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.balances).toMatchObject({
      availableToCashOutCents: 12_000,
      pendingClearanceCents: 2_500,
      scheduledPayoutCents: 3_000,
      paidOutCents: 8_000,
      paidOutHistoryComplete: true,
      adjustmentsAndHoldsCents: 4_150,
      lifetimeEarnedCents: 8_300,
    });
    expect(result.data.destination).toEqual({
      type: 'bank_account', last4: '4242', label: 'Example Bank',
    });
    expect(result.data.recentTaskEarnings[0]).toMatchObject({
      grossTaskCents: 10_000,
      quotedHustlerPayoutCents: 8_500,
      platformFeeCents: 1_500,
      insuranceAdjustmentCents: 200,
      netReleasedCents: 8_300,
      state: 'connected_balance',
    });
    expect(result.data.recentTaskEarnings[0].reason).toMatch(/not bank receipt/i);
    expect(result.data.categoryPerformance[0]).toMatchObject({
      category: 'moving', regionCode: 'US-WA', verifiedAssignments: 5,
      verifiedCompletions: 4, completionRatePercent: 80,
      proofCompletenessPercent: 75, disputeRatePercent: 25,
      repeatCustomerCount: 2, transactionReviewCount: 3,
      weightedOverallRating: 4.67, experienceBand: 'building_history',
      evidenceLabel: 'verified_production_transactions',
    });
    expect(result.data.preferredWorkOpportunities[0]).toMatchObject({
      id: 'preferred_rebook:task-repeat', kind: 'preferred_rebook',
      taskId: 'task-repeat', payoutCents: 8_500, state: 'open',
    });
    expect(result.data.preferredWorkOpportunities[0].reason).toMatch(/not assigned until accepted/i);
  });

  it('fails closed when provider data cannot be verified', async () => {
    const result = await HustlerWalletService.getOverview('worker-1', provider({
      getSnapshot: vi.fn(async () => { throw new Error('provider down'); }),
    }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.availability.status).toBe('temporarily_unavailable');
    expect(result.data.balances.availableToCashOutCents).toBeNull();
  });
});

describe('HustlerWalletService.reviewCashOut', () => {
  it('reviews exact standard amount, zero fee, net, destination, estimate and failure behavior', async () => {
    const result = await HustlerWalletService.reviewCashOut('worker-1', 5_000, provider());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      eligible: true,
      eligibilityCode: 'ELIGIBLE',
      amountCents: 5_000,
      feeCents: 0,
      netCents: 5_000,
      availableCents: 12_000,
      destination: { type: 'bank_account', last4: '4242', label: 'Example Bank' },
      method: 'standard',
      arrivalEstimate: { source: 'platform_estimate', exact: false },
    });
    expect(result.data.failureBehavior).toMatch(/returns the funds/i);
  });

  it('blocks cash-out while another provider payout is active', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM worker_cash_out_requests')) return {
        rows: [{ state: 'SUBMITTED' }], rowCount: 1,
      } as never;
      return baseQuery(sql) as never;
    });
    const result = await HustlerWalletService.reviewCashOut('worker-1', 5_000, provider());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.eligibilityCode).toBe('ACTIVE_CASH_OUT');
  });

  it('blocks an amount above the provider-verified balance', async () => {
    const result = await HustlerWalletService.reviewCashOut('worker-1', 20_000, provider());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.eligibilityCode).toBe('INSUFFICIENT_AVAILABLE_BALANCE');
  });
});

describe('HustlerWalletService.requestCashOut', () => {
  it('records initiating before provider submission and returns only provider-backed submitted state', async () => {
    const calls: string[] = [];
    let inserted = false;
    const requestRow = {
      id: 'req-1', worker_id: 'worker-1', provider_account_id: 'acct_worker',
      provider_destination_id: 'ba_123', provider_payout_id: null,
      idempotency_key: 'cashout-key-1', request_hash: '', state: 'INITIATING',
      amount_cents: 5_000, fee_cents: 0, net_cents: 5_000,
      destination_type: 'BANK_ACCOUNT', destination_last4: '4242', destination_label: 'Example Bank',
      estimated_arrival_at: null, failure_code: null, failure_message: null,
      created_at: now, updated_at: now,
    };
    mockDb.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('FROM users u')) return accountResult();
      if (sql.includes('FROM worker_cash_out_requests') && sql.includes('idempotency_key =')) {
        return inserted ? { rows: [requestRow], rowCount: 1 } as never : emptyResult();
      }
      if (sql.includes('FROM worker_cash_out_requests')) return emptyResult();
      if (sql.startsWith('INSERT INTO worker_cash_out_requests')) {
        inserted = true;
        requestRow.request_hash = String(values?.[4]);
        return { rows: [requestRow], rowCount: 1 } as never;
      }
      if (sql.startsWith('UPDATE worker_cash_out_requests')) return {
        rows: [{
          ...requestRow, provider_payout_id: 'po_new', state: 'SUBMITTED',
          estimated_arrival_at: '2026-07-21T12:00:00.000Z',
        }], rowCount: 1,
      } as never;
      return baseQuery(sql) as never;
    });
    const payoutProvider = provider();

    const result = await HustlerWalletService.requestCashOut({
      workerId: 'worker-1', amountCents: 5_000, idempotencyKey: 'cashout-key-1',
    }, payoutProvider);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.state).toBe('submitted');
    expect(result.data.feeCents).toBe(0);
    expect(payoutProvider.createStandardPayout).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acct_worker', amountCents: 5_000, destinationId: 'ba_123', requestId: 'req-1',
    }));
    expect(calls.findIndex((sql) => sql.startsWith('INSERT INTO worker_cash_out_requests')))
      .toBeLessThan(calls.findIndex((sql) => sql.startsWith('UPDATE worker_cash_out_requests')));
  });

  it('records provider rejection as failed and never invents paid progress', async () => {
    let inserted = false;
    const requestRow = {
      id: 'req-2', worker_id: 'worker-1', provider_account_id: 'acct_worker',
      provider_destination_id: 'ba_123', provider_payout_id: null,
      idempotency_key: 'cashout-key-2', request_hash: '', state: 'INITIATING',
      amount_cents: 5_000, fee_cents: 0, net_cents: 5_000,
      destination_type: 'BANK_ACCOUNT', destination_last4: '4242', destination_label: 'Example Bank',
      estimated_arrival_at: null, failure_code: null, failure_message: null,
      created_at: now, updated_at: now,
    };
    mockDb.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM users u')) return accountResult();
      if (sql.includes('FROM worker_cash_out_requests') && sql.includes('idempotency_key =')) {
        return inserted ? { rows: [requestRow], rowCount: 1 } as never : emptyResult();
      }
      if (sql.includes('FROM worker_cash_out_requests')) return emptyResult();
      if (sql.startsWith('INSERT INTO worker_cash_out_requests')) {
        inserted = true;
        requestRow.request_hash = String(values?.[4]);
        return { rows: [requestRow], rowCount: 1 } as never;
      }
      if (sql.startsWith('UPDATE worker_cash_out_requests')) return {
        rows: [{
          ...requestRow, state: 'FAILED', failure_code: 'account_closed',
          failure_message: 'Stripe could not submit this bank payout. No paid state was recorded; verify the destination and try a new cash-out.',
        }], rowCount: 1,
      } as never;
      return baseQuery(sql) as never;
    });
    const result = await HustlerWalletService.requestCashOut({
      workerId: 'worker-1', amountCents: 5_000, idempotencyKey: 'cashout-key-2',
    }, provider({ createStandardPayout: vi.fn(async () => { throw Object.assign(new Error('closed'), { code: 'account_closed' }); }) }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.state).toBe('failed');
    expect(result.data.failureCode).toBe('account_closed');
    expect(result.data.recoveryAction).toMatch(/new cash-out/i);
  });
});

describe('HustlerWalletService.syncProviderPayoutEvent', () => {
  const providerRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'req-1',
    worker_id: 'worker-1',
    provider_account_id: 'acct_worker',
    provider_payout_id: 'po_1',
    state: 'SUBMITTED',
    amount_cents: 5_000,
    fee_cents: 0,
    net_cents: 5_000,
    currency: 'usd',
    ...overrides,
  });

  function mockProviderSync(
    row: ReturnType<typeof providerRow>,
    existingEvent: Record<string, unknown> | null = null,
  ) {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM worker_cash_out_requests') && sql.includes('FOR UPDATE')) {
        return { rows: [row], rowCount: 1 } as never;
      }
      if (sql.includes('FROM worker_cash_out_events') && sql.includes('provider_event_id=$1')) {
        return { rows: existingEvent ? [existingEvent] : [], rowCount: existingEvent ? 1 : 0 } as never;
      }
      return { rows: [], rowCount: 1 } as never;
    });
  }

  it('uses provider event evidence to move a submitted payout to paid', async () => {
    mockProviderSync(providerRow());
    const result = await HustlerWalletService.syncProviderPayoutEvent({
      stripeEventId: 'evt_paid', providerPayoutId: 'po_1', state: 'paid', amountCents: 5_000,
      accountId: 'acct_worker', requestId: 'req-1', estimatedArrivalAt: now,
      failureCode: null, failureMessage: null,
    });
    expect(result).toEqual({ matched: true, workerId: 'worker-1' });
    const receipt = mockDb.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO worker_cash_out_events'));
    expect(receipt?.[1]).toEqual(expect.arrayContaining(['PAID', 'evt_paid', 'PAID', 'APPLIED']));
    const update = mockDb.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE worker_cash_out_requests'))!;
    expect(update[0]).toMatch(/last_transition_source\s*=\s*'PROVIDER_WEBHOOK'/u);
    expect(update[1]).toContain('evt_paid');
    expect(update[1]).toContain('PAID');
  });

  it('retains a stale processing event without regressing provider-paid evidence', async () => {
    mockProviderSync(providerRow({ state: 'PAID' }));
    const result = await HustlerWalletService.syncProviderPayoutEvent({
      stripeEventId: 'evt_stale',
      providerPayoutId: 'po_1',
      state: 'provider_processing',
      amountCents: 5_000,
      accountId: 'acct_worker',
      requestId: 'req-1',
      estimatedArrivalAt: now,
      failureCode: null,
      failureMessage: null,
    });
    expect(result).toEqual({ matched: true, workerId: 'worker-1' });
    const receipt = mockDb.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO worker_cash_out_events'));
    expect(receipt?.[1]).toEqual(expect.arrayContaining([
      'PAID', 'evt_stale', 'PROVIDER_PROCESSING', 'IGNORED_STALE',
    ]));
    const update = mockDb.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE worker_cash_out_requests'))!;
    expect(update[0]).not.toContain('state=$3');
  });

  it('projects a documented late provider failure after paid as reversed', async () => {
    mockProviderSync(providerRow({ state: 'PAID' }));
    await expect(HustlerWalletService.syncProviderPayoutEvent({
      stripeEventId: 'evt_late_failure',
      providerPayoutId: 'po_1',
      state: 'failed',
      amountCents: 5_000,
      accountId: 'acct_worker',
      requestId: 'req-1',
      estimatedArrivalAt: null,
      failureCode: 'bank_returned',
      failureMessage: 'Destination bank returned the payout.',
    })).resolves.toEqual({ matched: true, workerId: 'worker-1' });
    const receipt = mockDb.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO worker_cash_out_events'));
    expect(receipt?.[1]).toEqual(expect.arrayContaining([
      'REVERSED', 'evt_late_failure', 'FAILED', 'APPLIED',
    ]));
    const update = mockDb.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE worker_cash_out_requests'))!;
    expect(update[1]).toEqual(expect.arrayContaining(['REVERSED', 'bank_returned', 'evt_late_failure']));
  });

  it('rejects amount and bound-provider identity mismatches before writing an event', async () => {
    mockProviderSync(providerRow());
    await expect(HustlerWalletService.syncProviderPayoutEvent({
      stripeEventId: 'evt_wrong_amount',
      providerPayoutId: 'po_1',
      state: 'paid',
      amountCents: 4_999,
      accountId: 'acct_worker',
      requestId: 'req-1',
      estimatedArrivalAt: null,
      failureCode: null,
      failureMessage: null,
    })).rejects.toThrow('PAYOUT_EVENT_AMOUNT_MISMATCH');
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO worker_cash_out_events'))).toBe(false);

    vi.clearAllMocks();
    mockProviderSync(providerRow());
    await expect(HustlerWalletService.syncProviderPayoutEvent({
      stripeEventId: 'evt_wrong_identity',
      providerPayoutId: 'po_other',
      state: 'paid',
      amountCents: 5_000,
      accountId: 'acct_worker',
      requestId: 'req-1',
      estimatedArrivalAt: null,
      failureCode: null,
      failureMessage: null,
    })).rejects.toThrow('PAYOUT_EVENT_PAYOUT_ID_MISMATCH');
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO worker_cash_out_events'))).toBe(false);
  });

  it('accepts an exact provider-event replay and rejects changed replay payload', async () => {
    const receipt = {
      cash_out_request_id: 'req-1',
      provider_payout_id: 'po_1',
      amount_cents: 5_000,
      provider_reported_state: 'PAID',
    };
    mockProviderSync(providerRow({ state: 'PAID' }), receipt);
    const input = {
      stripeEventId: 'evt_paid',
      providerPayoutId: 'po_1',
      state: 'paid' as const,
      amountCents: 5_000,
      accountId: 'acct_worker',
      requestId: 'req-1',
      estimatedArrivalAt: null,
      failureCode: null,
      failureMessage: null,
    };
    await expect(HustlerWalletService.syncProviderPayoutEvent(input))
      .resolves.toEqual({ matched: true, workerId: 'worker-1' });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO worker_cash_out_events'))).toBe(false);

    vi.clearAllMocks();
    mockProviderSync(providerRow({ state: 'PAID' }), receipt);
    await expect(HustlerWalletService.syncProviderPayoutEvent({ ...input, state: 'failed' }))
      .rejects.toThrow('PAYOUT_EVENT_REPLAY_CONFLICT');
  });
});
