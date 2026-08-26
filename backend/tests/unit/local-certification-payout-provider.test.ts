import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { identityQuery, query, transaction } = vi.hoisted(() => {
  const identityQuery = vi.fn();
  const query = vi.fn();
  const transaction = vi.fn(async (callback: (q: typeof query) => unknown) => callback(query));
  return { identityQuery, query, transaction };
});

vi.mock('../../src/db', () => ({
  db: { query: identityQuery, transaction },
}));

import {
  isLocalCertificationPayoutDestinationId,
  isLocalCertificationPayoutTransferId,
  LocalCertificationPayoutProvider,
  localCertificationPayoutEnabled,
} from '../../src/services/LocalCertificationPayoutProvider';

const enabled = {
  NODE_ENV: 'test',
  HXOS_ALLOW_LOCAL_TEST_PAYOUT: 'true',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_local_certification_payout',
  HX_PAYMENT_CREATION_MODE: 'enabled',
  HXOS_LOCAL_TEST_PAYOUT_SECRET: 'p'.repeat(64),
  DATABASE_URL: 'postgresql://hx_test_payout@127.0.0.1:5432/hx_payout_test',
  HXOS_LOCAL_TEST_DATABASE_ATTESTATION:
    'DISPOSABLE_LOOPBACK_RESTRICTED_PAYMENT_TEST_DATABASE_V1',
  HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_payout_test',
  HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_test_payout',
};

const original = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, enabled);
  identityQuery.mockResolvedValue({
    rows: [{ database_name: 'hx_payout_test', database_user: 'hx_test_payout' }],
    rowCount: 1,
  });
});

afterEach(() => {
  process.env = { ...original };
});

describe('LocalCertificationPayoutProvider', () => {
  it('is disabled by default and rejects every production-shaped configuration', () => {
    expect(localCertificationPayoutEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'development' },
      { HXOS_ALLOW_LOCAL_TEST_PAYOUT: 'false' },
      { ENGINE_API_MODE: 'live' },
      { STRIPE_MODE: 'live' },
      { STRIPE_SECRET_KEY: 'sk_live_forbidden' },
      { HX_PAYMENT_CREATION_MODE: 'frozen' },
      { HXOS_LOCAL_TEST_PAYOUT_SECRET: 'short' },
      { DATABASE_URL: 'postgresql://hx_test_payout@prod.internal:5432/hx_payout_test' },
      { DATABASE_URL: 'postgresql://hx_test_payout@127.0.0.1:5432/hustlexp' },
      { HXOS_LOCAL_TEST_DATABASE_NAME: 'wrong_test' },
      { HXOS_LOCAL_TEST_DATABASE_ROLE: '' },
    ]) {
      expect(localCertificationPayoutEnabled({ ...enabled, ...override })).toBe(false);
    }
  });

  it('fails before every database effect while payout creation is frozen', async () => {
    process.env.HX_PAYMENT_CREATION_MODE = 'frozen';

    const destination = await LocalCertificationPayoutProvider.activateDestination('worker-1', 'worker-1');
    const transfer = await LocalCertificationPayoutProvider.createPaidTransfer({
      taskId: 'task-1',
      escrowId: 'escrow-1',
      workerId: 'worker-1',
      idempotencyKey: 'settle-task-1',
    });

    expect(destination).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_CREATION_FROZEN' },
    });
    expect(transfer).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_CREATION_FROZEN' },
    });
    expect(identityQuery).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('fails before mutation when the connected database identity is not disposable', async () => {
    identityQuery.mockResolvedValueOnce({
      rows: [{ database_name: 'production', database_user: 'app_owner' }],
      rowCount: 1,
    });

    const result = await LocalCertificationPayoutProvider.createPaidTransfer({
      taskId: 'task-1',
      escrowId: 'escrow-1',
      workerId: 'worker-1',
      idempotencyKey: 'settle-task-1',
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'LOCAL_TEST_STORAGE_IDENTITY_MISMATCH' },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('uses provider-specific identities that cannot be mistaken for Stripe', () => {
    expect(isLocalCertificationPayoutDestinationId(`pd_hxos_test_${'a'.repeat(32)}`)).toBe(true);
    expect(isLocalCertificationPayoutTransferId(`tr_hxos_test_${'b'.repeat(32)}`)).toBe(true);
    expect(isLocalCertificationPayoutTransferId(`tr_test_${'b'.repeat(32)}`)).toBe(false);
    expect(isLocalCertificationPayoutTransferId('tr_123')).toBe(false);
  });

  it('activates one deterministic TEST destination and replays safely', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO hxos_local_test_payout_destinations')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM hxos_local_test_payout_destinations')) {
        return {
          rows: [{
            id: `pd_hxos_test_${'c'.repeat(32)}`,
            worker_id: 'worker-1',
            status: 'ACTIVE',
            is_test: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    // The deterministic ID depends on the secret, so capture it from the insert
    // and return the same identity from the locked read.
    let generatedId = '';
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO hxos_local_test_payout_destinations')) {
        generatedId = String(params?.[0]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM hxos_local_test_payout_destinations')) {
        return {
          rows: [{ id: generatedId, worker_id: 'worker-1', status: 'ACTIVE', is_test: true }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await LocalCertificationPayoutProvider.activateDestination('worker-1', 'worker-1');
    expect(result).toMatchObject({
      success: true,
      data: {
        provider: 'LOCAL_CERTIFICATION_TEST',
        status: 'ACTIVE',
        isTest: true,
        idempotencyReplayed: true,
      },
    });
    if (!result.success) throw new Error(result.error.message);
    expect(isLocalCertificationPayoutDestinationId(result.data.destinationId)).toBe(true);
  });

  it('replays an exact paid transfer without creating another transfer', async () => {
    const paid = {
      id: `tr_hxos_test_${'d'.repeat(32)}`,
      task_id: 'task-1',
      escrow_id: 'escrow-1',
      worker_id: 'worker-1',
      destination_id: `pd_hxos_test_${'e'.repeat(32)}`,
      amount_cents: 9490,
      status: 'paid',
      idempotency_key: 'settle-task-1',
      request_hash: '',
      is_test: true,
      paid_at: new Date(),
    };
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM hxos_local_test_payout_transfers')) {
        // Capture the service-computed hash without duplicating its algorithm.
        const { createHash } = await import('node:crypto');
        paid.request_hash = createHash('sha256').update(JSON.stringify({
          taskId: 'task-1', escrowId: 'escrow-1', workerId: 'worker-1',
        })).digest('hex');
        expect(params?.[0]).toBe('settle-task-1');
        return { rows: [paid], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await LocalCertificationPayoutProvider.createPaidTransfer({
      taskId: 'task-1',
      escrowId: 'escrow-1',
      workerId: 'worker-1',
      idempotencyKey: 'settle-task-1',
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        transferId: paid.id,
        provider: 'LOCAL_CERTIFICATION_TEST',
        status: 'paid',
        amountCents: 9490,
        isTest: true,
        idempotencyReplayed: true,
      },
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO hxos_local_test_payout_transfers'))).toBe(false);
  });

  it('creates the exact 9490-cent transfer through submitted, processing, and paid states', async () => {
    let generatedTransferId = '';
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM hxos_local_test_payout_transfers') && sql.includes('idempotency_key')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM tasks t') && sql.includes('FOR UPDATE OF t, e')) {
        return {
          rows: [{
            task_id: 'task-1',
            task_state: 'COMPLETED',
            payout_ready_at: new Date(),
            automation_classification: 'CONTROLLED_TEST',
            worker_id: 'worker-1',
            hustler_payout_cents: 9750,
            platform_margin_cents: 3250,
            escrow_id: 'escrow-1',
            escrow_state: 'FUNDED',
            amount: 13000,
            platform_fee_cents: 3250,
            destination_id: `pd_hxos_test_${'f'.repeat(32)}`,
            destination_status: 'ACTIVE',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO hxos_local_test_payout_transfers')) {
        generatedTransferId = String(params?.[0]);
        expect(params?.[5]).toBe(9490);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status = 'paid'")) {
        return {
          rows: [{
            id: generatedTransferId,
            task_id: 'task-1',
            escrow_id: 'escrow-1',
            worker_id: 'worker-1',
            destination_id: `pd_hxos_test_${'f'.repeat(32)}`,
            amount_cents: 9490,
            status: 'paid',
            idempotency_key: 'settle-task-1',
            request_hash: 'a'.repeat(64),
            is_test: true,
            paid_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await LocalCertificationPayoutProvider.createPaidTransfer({
      taskId: 'task-1',
      escrowId: 'escrow-1',
      workerId: 'worker-1',
      idempotencyKey: 'settle-task-1',
    });
    expect(result).toMatchObject({
      success: true,
      data: { amountCents: 9490, status: 'paid', idempotencyReplayed: false },
    });
    const statements = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain("to_status, event_type");
    expect(statements).toContain("SET status = 'processing'");
    expect(statements).toContain("SET status = 'paid'");
  });
});
