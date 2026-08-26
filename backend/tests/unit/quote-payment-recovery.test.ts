import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotePaymentProvider } from '../../src/services/payment/QuotePaymentProvider.js';
import { enableControlledStripePaymentTestCohortV7 } from '../helpers/payment-underwriting-v7.js';

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
  task: '10000000-0000-4000-8000-000000000008',
  escrow: '10000000-0000-4000-8000-000000000009',
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
    draft_poster_id: ids.poster,
    lead_user_id: ids.poster,
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
    idempotency_key: `quote-payment-recovery:${ids.payment}`,
    initial_claim_evidence_matches: true,
    ...overrides,
  };
}

function materializedContext(overrides: Record<string, unknown> = {}) {
  return {
    task_id: ids.task,
    task_poster_id: ids.poster,
    task_worker_id: null,
    task_business_fulfiller_id: null,
    task_provider_organization_id: null,
    task_provider_service_profile_id: null,
    task_provider_assignment_id: null,
    task_payout_recipient_user_id: null,
    task_state: 'OPEN',
    task_progress_state: 'POSTED',
    task_matched_at: null,
    task_live_broadcast_started_at: null,
    task_live_broadcast_expired_at: null,
    task_accepted_at: null,
    task_proof_submitted_at: null,
    task_completed_at: null,
    task_cancelled_at: null,
    task_expired_at: null,
    escrow_id: ids.escrow,
    escrow_state: 'PENDING',
    escrow_amount_cents: 12_500,
    escrow_provider_payment_id: input.paymentIntentId,
    escrow_transfer_id: null,
    escrow_refund_id: null,
    escrow_funded_at: null,
    escrow_released_at: null,
    escrow_refunded_at: null,
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
    {
      rows: [operation({
        claim_token: expect.any(String),
        expected_status: payment.status,
      })],
      rowCount: 1,
    },
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

  it('resumes the exact expired taskless claim after provider success, crash, and later task binding', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValue({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const taskBoundPayment = row({ task_id: ids.task });
    const [, crashQuery, resumeClaimQuery, resumeFinalQuery] = transactionSequences(
      successfulClaim(),
      [],
      [
        { rows: [taskBoundPayment], rowCount: 1 },
        {
          rows: [operation({
            lease_expired: true,
            expected_payment_version_matches: false,
          })],
          rowCount: 1,
        },
        { rows: [{ id: ids.operation }], rowCount: 1 },
        { rows: [{ id: 'renew-event' }], rowCount: 1 },
      ],
      [
        { rows: [taskBoundPayment], rowCount: 1 },
        { rows: [materializedContext()], rowCount: 1 },
        {
          rows: [operation({
            claim_token: expect.any(String),
            lease_expired: false,
            expected_payment_version_matches: false,
          })],
          rowCount: 1,
        },
        { rows: [{ id: ids.operation }], rowCount: 1 },
        { rows: [{ id: 'reconcile-event' }], rowCount: 1 },
      ],
    );

    const crashed = await recoverOrphanQuotePayment(input, quoteProvider);
    const resumed = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(crashed).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_FAILED' },
    });
    expect(crashQuery).toHaveBeenCalledTimes(1);
    expect(resumed).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED' },
    });
    expect(quoteProvider.recoverOrphanPayment).toHaveBeenCalledTimes(2);
    expect(quoteProvider.recoverOrphanPayment).toHaveBeenNthCalledWith(2, {
      ...input,
      amountCents: 12_500,
      recoveryKey: ids.payment,
    });
    expect(String(resumeClaimQuery?.mock.calls[2]?.[0])).toContain(
      'UPDATE quote_payment_recovery_operations',
    );
    expect(String(resumeClaimQuery?.mock.calls[3]?.[0])).toContain(
      'INSERT INTO quote_payment_recovery_events',
    );
    const resumedSql = [...resumeClaimQuery!.mock.calls, ...resumeFinalQuery!.mock.calls]
      .map(([statement]) => String(statement))
      .join('\n');
    expect(resumedSql).not.toMatch(/\bINSERT INTO quote_payment_recovery_operations\b/i);
    expect(resumedSql).not.toMatch(/\bUPDATE\s+(?:quote_payments|tasks|escrows)\b/i);
    expect(String(resumeFinalQuery?.mock.calls[3]?.[0])).toContain(
      "operation_state = 'RECONCILIATION_REQUIRED'",
    );
  });

  it('keeps an exact taskless claim with an active lease single-owner after task binding', async () => {
    const quoteProvider = provider();
    transactionSequences([
      { rows: [row({ task_id: ids.task })], rowCount: 1 },
      {
        rows: [operation({
          lease_expired: false,
          expected_payment_version_matches: false,
        })],
        rowCount: 1,
      },
    ]);

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_IN_PROGRESS' },
    });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
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
        { rows: [], rowCount: 0 },
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
    expect(String(finalQuery?.mock.calls[3]?.[0])).toContain(
      "operation_state = 'RECONCILIATION_REQUIRED'",
    );
    expect(finalQuery?.mock.calls[4]?.[1]).toContain('RECONCILIATION_REQUIRED');
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
    [row({ draft_poster_id: null }), 'QUOTE_PAYMENT_POSTER_MISMATCH'],
    [row({ lead_user_id: null }), 'QUOTE_PAYMENT_POSTER_MISMATCH'],
    [
      row({
        draft_poster_id: '20000000-0000-4000-8000-000000000001',
        lead_user_id: ids.poster,
        poster_email: 'Poster@Example.com',
        lead_email: 'poster@example.com',
      }),
      'QUOTE_PAYMENT_POSTER_MISMATCH',
    ],
    [
      row({
        draft_poster_id: '20000000-0000-4000-8000-000000000001',
        lead_user_id: '20000000-0000-4000-8000-000000000001',
      }),
      'QUOTE_PAYMENT_POSTER_MISMATCH',
    ],
    [row({ provider: 'other' }), 'QUOTE_PAYMENT_PROVIDER_MISMATCH'],
  ])('rejects an ineligible obligation before claiming or provider work', async (lockedRow, code) => {
    const quoteProvider = provider();
    const [query] = transactionSequences([{ rows: [lockedRow], rowCount: 1 }]);

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({ success: false, error: { code } });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('loads only durable actor links and never email authority', async () => {
    const quoteProvider = provider();
    const [query] = transactionSequences([
      { rows: [row({ draft_poster_id: null })], rowCount: 1 },
    ]);

    await recoverOrphanQuotePayment(input, quoteProvider);

    const sql = String(query?.mock.calls[0]?.[0]);
    expect(sql).toContain('d.poster_user_id AS draft_poster_id');
    expect(sql).toContain('l.user_id AS lead_user_id');
    expect(sql).not.toMatch(/\bemail\b/i);
    expect(query?.mock.calls[0]?.[1]).toEqual([
      input.quoteId,
      input.quoteVersionId,
      input.paymentIntentId,
    ]);
  });

  it.each(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] as const)(
    'blocks task-bound %s recovery before provider calls or canonical writes',
    async (status) => {
      const quoteProvider = provider();
      const [query] = transactionSequences([
        { rows: [row({ task_id: ids.task, status })], rowCount: 1 },
        { rows: [], rowCount: 0 },
      ]);

      const result = await recoverOrphanQuotePayment(input, quoteProvider);

      expect(result).toMatchObject({
        success: false,
        error: { code: 'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED' },
      });
      expect(quoteProvider.createPaymentIntent).not.toHaveBeenCalled();
      expect(quoteProvider.verifySucceededPayment).not.toHaveBeenCalled();
      expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(db.query).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(2);
      expect(String(query?.mock.calls[0]?.[0])).toContain('FOR UPDATE OF qp');
      const statements = query!.mock.calls
        .map(([statement]) => String(statement).trimStart());
      expect(statements).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i),
      ]));
    },
  );

  it.each([
    [
      'wrong operation payment identity',
      row({ task_id: ids.task }),
      operation({
        quote_payment_id: '20000000-0000-4000-8000-000000000001',
        lease_expired: true,
        expected_payment_version_matches: false,
      }),
      'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
    ],
    [
      'wrong actor',
      row({ task_id: ids.task }),
      operation({
        actor_id: '20000000-0000-4000-8000-000000000002',
        lease_expired: true,
        expected_payment_version_matches: false,
      }),
      'QUOTE_PAYMENT_RECOVERY_ACTOR_CONFLICT',
    ],
    [
      'wrong reason',
      row({ task_id: ids.task }),
      operation({
        reason_code: 'POSTER_REQUESTED_CANCELLATION',
        lease_expired: true,
        expected_payment_version_matches: false,
      }),
      'QUOTE_PAYMENT_RECOVERY_REASON_CONFLICT',
    ],
    [
      'wrong taskless witness key',
      row({ task_id: ids.task }),
      operation({
        idempotency_key: `quote-payment-recovery:${ids.payment}:forged`,
        lease_expired: true,
        expected_payment_version_matches: false,
      }),
      'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
    ],
    [
      'missing immutable initial claim evidence',
      row({ task_id: ids.task }),
      operation({
        initial_claim_evidence_matches: false,
        lease_expired: true,
        expected_payment_version_matches: false,
      }),
      'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
    ],
    [
      'no post-claim payment version change',
      row({ task_id: ids.task }),
      operation({ lease_expired: true, expected_payment_version_matches: true }),
      'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
    ],
    [
      'non-pending original claim',
      row({ task_id: ids.task }),
      operation({
        expected_status: 'SUCCEEDED',
        lease_expired: true,
        expected_payment_version_matches: false,
      }),
      'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
    ],
    [
      'terminal operation',
      row({ task_id: ids.task }),
      operation({
        operation_state: 'RECONCILIATION_REQUIRED',
        recovery_action: 'VOIDED',
        provider_status: 'canceled',
        provider_operation_id: input.paymentIntentId,
        lease_expired: true,
        expected_payment_version_matches: false,
      }),
      'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
    ],
  ])('rejects a task-bound recovery with %s before effects', async (
    _label,
    payment,
    priorOperation,
    code,
  ) => {
    const quoteProvider = provider();
    const [query] = transactionSequences([
      { rows: [payment], rowCount: 1 },
      { rows: [priorOperation], rowCount: 1 },
    ]);

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({ success: false, error: { code } });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
    const statements = query!.mock.calls
      .map(([statement]) => String(statement).trimStart());
    expect(statements).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i),
    ]));
  });

  it('is unavailable when the isolated payment-creation cohort is enabled', async () => {
    enableControlledStripePaymentTestCohortV7();
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_recovery_conflict');
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
