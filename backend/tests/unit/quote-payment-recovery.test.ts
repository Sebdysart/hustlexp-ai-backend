import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotePaymentProvider } from '../../src/services/payment/QuotePaymentProvider.js';

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

const { db } = await import('../../src/db.js');
const { recoverOrphanQuotePayment } = await import(
  '../../src/services/QuotePaymentRecoveryService.js'
);

const ids = {
  quote: '10000000-0000-4000-8000-000000000001',
  version: '10000000-0000-4000-8000-000000000002',
  poster: '10000000-0000-4000-8000-000000000003',
  payment: '10000000-0000-4000-8000-000000000004',
  operation: '10000000-0000-4000-8000-000000000005',
};

const input = {
  quoteId: ids.quote,
  quoteVersionId: ids.version,
  posterId: ids.poster,
  paymentIntentId: 'pi_orphan_quote_payment_123',
  reasonCode: 'UNDERWRITING_CONTAINMENT' as const,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.payment,
    task_id: null,
    provider: 'stripe',
    provider_payment_id: input.paymentIntentId,
    amount_cents: 12_500,
    status: 'PENDING',
    updated_at: new Date('2026-08-23T00:00:00.000Z'),
    poster_email: 'poster@example.com',
    lead_email: 'poster@example.com',
    ...overrides,
  };
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.operation,
    quote_payment_id: ids.payment,
    actor_id: ids.poster,
    reason_code: input.reasonCode,
    expected_status: 'PENDING',
    expected_payment_version_matches: true,
    operation_state: 'CLAIMED',
    claim_token: '10000000-0000-4000-8000-000000000006',
    correlation_id: '10000000-0000-4000-8000-000000000007',
    lease_expired: false,
    recovery_action: null,
    provider_status: null,
    provider_operation_id: null,
    ...overrides,
  };
}

function provider() {
  return {
    createPaymentIntent: vi.fn(),
    verifySucceededPayment: vi.fn(),
    recoverOrphanPayment: vi.fn(),
  } satisfies QuotePaymentProvider;
}

function transactionSequences(
  ...transactions: Array<Array<Record<string, unknown>>>
): Array<ReturnType<typeof vi.fn>> {
  const queries = transactions.map((results) => {
    const query = vi.fn();
    for (const result of results) query.mockResolvedValueOnce(result);
    return query;
  });
  let index = 0;
  vi.mocked(db.transaction).mockImplementation(async (work) => {
    const query = queries[index++];
    if (!query) throw new Error('UNEXPECTED_TRANSACTION');
    return work(query);
  });
  return queries;
}

function successfulClaim(payment = row()) {
  return [
    { rows: [payment], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ id: ids.operation }], rowCount: 1 },
    { rows: [{ id: 'claim-event' }], rowCount: 1 },
  ];
}

function successfulFinalize(payment = row()) {
  return [
    { rows: [payment], rowCount: 1 },
    { rows: [operation({ claim_token: expect.any(String) })], rowCount: 1 },
    { rows: [{ id: ids.payment }], rowCount: 1 },
    { rows: [{ id: ids.operation }], rowCount: 1 },
    { rows: [{ id: 'terminal-event' }], rowCount: 1 },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('quote payment orphan recovery', () => {
  it('commits a durable claim before processor work and then records terminal void evidence', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const [claimQuery, finalQuery] = transactionSequences(
      successfulClaim(),
      successfulFinalize(),
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toEqual({
      success: true,
      data: {
        quoteId: ids.quote,
        quoteVersionId: ids.version,
        paymentIntentId: input.paymentIntentId,
        status: 'FAILED',
        recoveryAction: 'VOIDED',
        replayed: false,
      },
    });
    expect(quoteProvider.recoverOrphanPayment).toHaveBeenCalledWith({
      ...input,
      amountCents: 12_500,
      recoveryKey: ids.payment,
    });
    expect(String(claimQuery?.mock.calls[0]?.[0])).toContain('FOR UPDATE OF qp');
    expect(String(claimQuery?.mock.calls[2]?.[0])).toContain(
      'INSERT INTO quote_payment_recovery_operations',
    );
    expect(String(claimQuery?.mock.calls[3]?.[0])).toContain(
      'INSERT INTO quote_payment_recovery_events',
    );
    expect(vi.mocked(db.transaction).mock.invocationCallOrder[0]).toBeLessThan(
      quoteProvider.recoverOrphanPayment.mock.invocationCallOrder[0]!,
    );
    expect(quoteProvider.recoverOrphanPayment.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.transaction).mock.invocationCallOrder[1]!,
    );
    expect(String(finalQuery?.mock.calls[0]?.[0])).toContain('FOR UPDATE OF qp');
    expect(String(finalQuery?.mock.calls[1]?.[0])).toContain(
      'FROM quote_payment_recovery_operations',
    );
    expect(finalQuery?.mock.calls[2]?.[1]).toEqual([
      'FAILED', ids.payment, 'PENDING', ids.operation,
    ]);
    const sql = [...claimQuery!.mock.calls, ...finalQuery!.mock.calls]
      .map(([statement]) => String(statement))
      .join('\n');
    expect(sql).not.toMatch(/\b(?:INSERT INTO tasks|INSERT INTO escrows)\b/i);
  });

  it('refunds a succeeded orphan through the same claim/finalize operation', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'REFUNDED',
        providerStatus: 'succeeded',
        providerOperationId: 're_quote_recovery_123',
      },
    });
    const succeeded = row({ status: 'SUCCEEDED' });
    const [, finalQuery] = transactionSequences(
      successfulClaim(succeeded),
      successfulFinalize(succeeded),
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: true,
      data: { status: 'REFUNDED', recoveryAction: 'REFUNDED', replayed: false },
    });
    expect(finalQuery?.mock.calls[2]?.[1]).toEqual([
      'REFUNDED', ids.payment, 'SUCCEEDED', ids.operation,
    ]);
  });

  it.each([
    ['FAILED', 'VOIDED'],
    ['REFUNDED', 'REFUNDED'],
  ] as const)(
    'permits zero-effect terminal %s replay only with a matching completed operation and event',
    async (status, action) => {
      const quoteProvider = provider();
      const [query] = transactionSequences([
        { rows: [row({ status })], rowCount: 1 },
        {
          rows: [operation({
            expected_status: status,
            operation_state: 'COMPLETED',
            recovery_action: action,
            provider_status: status === 'FAILED' ? 'canceled' : 'succeeded',
            provider_operation_id: status === 'FAILED' ? input.paymentIntentId : 're_existing',
          })],
          rowCount: 1,
        },
        { rows: [{ id: 'terminal-event' }], rowCount: 1 },
      ]);

      const result = await recoverOrphanQuotePayment(input, quoteProvider);

      expect(result).toMatchObject({
        success: true,
        data: { status, recoveryAction: action, replayed: true },
      });
      expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(3);
      expect(db.transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed when terminal local state lacks immutable recovery evidence', async () => {
    const quoteProvider = provider();
    transactionSequences([
      { rows: [row({ status: 'FAILED' })], rowCount: 1 },
      {
        rows: [operation({
          expected_status: 'FAILED',
          operation_state: 'COMPLETED',
          recovery_action: 'VOIDED',
          provider_status: 'canceled',
          provider_operation_id: input.paymentIntentId,
        })],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 },
    ]);

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_EVIDENCE_MISSING' },
    });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
  });

  it('reconciles a legacy terminal row without an operation instead of trusting local status', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const terminal = row({ status: 'FAILED' });
    const [, finalQuery] = transactionSequences(
      successfulClaim(terminal),
      [
        { rows: [terminal], rowCount: 1 },
        { rows: [operation({ expected_status: 'FAILED', claim_token: expect.any(String) })], rowCount: 1 },
        { rows: [{ id: ids.operation }], rowCount: 1 },
        { rows: [{ id: 'terminal-event' }], rowCount: 1 },
      ],
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: true,
      data: { status: 'FAILED', recoveryAction: 'VOIDED', replayed: true },
    });
    expect(finalQuery).toHaveBeenCalledTimes(4);
  });

  it('blocks concurrent processor work while a durable lease is active', async () => {
    const quoteProvider = provider();
    transactionSequences([
      { rows: [row()], rowCount: 1 },
      { rows: [operation({ lease_expired: false })], rowCount: 1 },
    ]);

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_IN_PROGRESS' },
    });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
  });

  it('renews an expired claim and reuses the deterministic provider recovery key', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    transactionSequences(
      [
        { rows: [row()], rowCount: 1 },
        { rows: [operation({ lease_expired: true })], rowCount: 1 },
        { rows: [{ id: ids.operation }], rowCount: 1 },
        { rows: [{ id: 'renew-event' }], rowCount: 1 },
      ],
      successfulFinalize(),
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result.success).toBe(true);
    expect(quoteProvider.recoverOrphanPayment).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryKey: ids.payment }),
    );
  });

  it('records reconciliation-required evidence if materialization wins after the claim', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const [, finalQuery] = transactionSequences(
      successfulClaim(),
      [
        { rows: [row({ task_id: 'task-raced' })], rowCount: 1 },
        { rows: [operation({ claim_token: expect.any(String) })], rowCount: 1 },
        { rows: [{ id: ids.operation }], rowCount: 1 },
        { rows: [{ id: 'reconcile-event' }], rowCount: 1 },
      ],
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED' },
    });
    expect(String(finalQuery?.mock.calls[2]?.[0])).toContain(
      "operation_state = 'RECONCILIATION_REQUIRED'",
    );
    expect(finalQuery?.mock.calls[3]?.[1]).toContain('RECONCILIATION_REQUIRED');
  });

  it('uses the database-native payment witness and reconciles any version drift', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const [, finalQuery] = transactionSequences(
      successfulClaim(),
      [
        { rows: [row()], rowCount: 1 },
        {
          rows: [operation({
            claim_token: expect.any(String),
            expected_payment_version_matches: false,
          })],
          rowCount: 1,
        },
        { rows: [{ id: ids.operation }], rowCount: 1 },
        { rows: [{ id: 'reconcile-event' }], rowCount: 1 },
      ],
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED' },
    });
    expect(String(finalQuery?.mock.calls[1]?.[0])).toContain(
      'expected_payment_version_matches',
    );
    expect(String(finalQuery?.mock.calls[2]?.[0])).toContain(
      "operation_state = 'RECONCILIATION_REQUIRED'",
    );
  });

  it('persists provider failure on the durable claim without canonical money mutation', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: false,
      error: { code: 'PAYMENT_REFUND_PENDING', message: 'Refund is pending' },
    });
    transactionSequences(successfulClaim(row({ status: 'SUCCEEDED' })));
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_PENDING' },
    });
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).toContain('last_error_code');
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    [row({ poster_email: 'attacker@example.com' }), 'QUOTE_PAYMENT_POSTER_MISMATCH'],
    [row({ provider: 'other' }), 'QUOTE_PAYMENT_PROVIDER_MISMATCH'],
    [row({ task_id: 'task-existing' }), 'QUOTE_PAYMENT_ALREADY_MATERIALIZED'],
  ])('rejects an ineligible obligation before claiming or provider work', async (lockedRow, code) => {
    const quoteProvider = provider();
    const results = [{ rows: [lockedRow], rowCount: 1 }];
    if (lockedRow.task_id) results.push({ rows: [], rowCount: 0 });
    const [query] = transactionSequences(results);

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({ success: false, error: { code } });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(lockedRow.task_id ? 2 : 1);
  });

  it('surfaces a durable recovery/materialization collision as reconciliation required', async () => {
    const quoteProvider = provider();
    transactionSequences([
      { rows: [row({ task_id: 'task-raced' })], rowCount: 1 },
      { rows: [operation()], rowCount: 1 },
    ]);

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED' },
    });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
  });

  it('is unavailable when the isolated payment-creation cohort is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ENGINE_API_MODE', 'test');
    vi.stubEnv('STRIPE_MODE', 'test');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_recovery_conflict');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');
    const quoteProvider = provider();

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_NOT_AVAILABLE' },
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
  });
});
