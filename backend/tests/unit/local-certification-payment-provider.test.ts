import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

const { db } = await import('../../src/db.js');
const {
  LocalCertificationPaymentProvider,
  isLocalCertificationPaymentIntentId,
  localCertificationPaymentEnabled,
} = await import('../../src/services/LocalCertificationPaymentProvider.js');

const enabled = {
  NODE_ENV: 'test',
  HXOS_ALLOW_LOCAL_TEST_PAYMENT: 'true',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HXOS_LOCAL_TEST_PAYMENT_SECRET: 'local-payment-secret-is-at-least-thirty-two-chars',
};

function enable(): void {
  for (const [key, value] of Object.entries(enabled)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('local certification payment provider', () => {
  it('requires every non-production TEST guard and a strong secret', () => {
    expect(localCertificationPaymentEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' },
      { HXOS_ALLOW_LOCAL_TEST_PAYMENT: 'false' },
      { ENGINE_API_MODE: 'live' },
      { STRIPE_MODE: 'live' },
      { HXOS_LOCAL_TEST_PAYMENT_SECRET: 'weak' },
    ]) expect(localCertificationPaymentEnabled({ ...enabled, ...override })).toBe(false);
  });

  it('creates a deterministic TEST intent and reuses only equivalent state', async () => {
    enable();
    const query = vi.fn();
    vi.mocked(db.transaction).mockImplementation(async (work) => work(query));
    let inserted: unknown[] = [];
    query.mockImplementationOnce(async (_sql: string, values: unknown[]) => {
      inserted = values;
      return { rows: [], rowCount: 1 };
    });
    query.mockImplementationOnce(async () => ({
      rows: [{
        id: inserted[0], task_id: 'task-1', escrow_id: 'escrow-1', poster_id: 'poster-1',
        amount_cents: 13000, status: 'requires_confirmation',
        client_secret_hash: inserted[5], is_test: true,
      }],
      rowCount: 1,
    }));
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await LocalCertificationPaymentProvider.createIntent({
      taskId: 'task-1', escrowId: 'escrow-1', posterId: 'poster-1', amountCents: 13000,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(isLocalCertificationPaymentIntentId(result.data.paymentIntentId)).toBe(true);
    expect(result.data.clientSecret).toMatch(new RegExp(`^${result.data.paymentIntentId}_secret_[a-f0-9]{64}$`));
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('rejects confirmation with the wrong hashed client secret', async () => {
    enable();
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      id: `pi_hxos_test_${'a'.repeat(32)}`, task_id: 'task-1', escrow_id: 'escrow-1',
      poster_id: 'poster-1', amount_cents: 13000, status: 'requires_confirmation',
      client_secret_hash: 'b'.repeat(64), is_test: true,
    }] });
    vi.mocked(db.transaction).mockImplementation(async (work) => work(query));
    const result = await LocalCertificationPaymentProvider.confirmIntent({
      paymentIntentId: `pi_hxos_test_${'a'.repeat(32)}`,
      clientSecret: 'wrong-secret',
      posterId: 'poster-1',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LOCAL_TEST_PAYMENT_SECRET_INVALID');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('verifies only a succeeded intent with exact task, escrow, Poster, and amount', async () => {
    enable();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ amount_cents: 13000 }], rowCount: 1 });
    const result = await LocalCertificationPaymentProvider.verifySucceededIntent({
      paymentIntentId: `pi_hxos_test_${'a'.repeat(32)}`,
      escrowId: 'escrow-1', taskId: 'task-1', posterId: 'poster-1', amountCents: 13000,
    });
    expect(result).toEqual({ success: true, data: { status: 'succeeded', amountCents: 13000 } });
    const params = vi.mocked(db.query).mock.calls[0]?.[1];
    expect(params).toEqual([
      `pi_hxos_test_${'a'.repeat(32)}`, 'escrow-1', 'task-1', 'poster-1', 13000,
    ]);
  });
});
