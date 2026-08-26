/**
 * EscrowService Branch Coverage Tests
 *
 * Targets backend/src/services/EscrowService.ts branches NOT covered by
 * the existing escrow-service.test.ts:
 *
 * - getByTaskId: NOT_FOUND, DB_ERROR
 * - release: escrow not found (empty rows on first SELECT)
 * - release: task not found / no worker assigned
 * - release: worker not found in KYC query
 * - release: stripe_connect_id missing (KYC gate)
 * - release: payouts_enabled=false (KYC gate)
 * - release: XP-TAX-BLOCK error path (warn+continue)
 * - release: unexpected XP error path (error+continue)
 * - release: rowCount=0 path when escrow is NOT found by getById after update
 * - release: rowCount=0 path when escrow IS terminal via getById
 * - release: rowCount=0 path when escrow is in wrong state (INVALID_STATE)
 * - refund: rowCount=0 path — getById returns not found
 * - refund: rowCount=0 path — escrow is terminal
 * - lockForDispute: rowCount=0 path — getById fallback INVALID_STATE
 * - partialRefund: percentages don't sum to 100
 * - partialRefund: rowCount=0 path — getById fallback
 * - logEscrowEvent: DB failure (non-fatal, only logs error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const payoutDestination = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
  },
}));

vi.mock('../../src/logger', () => ({
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  taskLogger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: {
    recordEarnings: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: {
    recordOfflinePayment: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: {
    awardXP: vi.fn().mockResolvedValue(undefined),
    clawbackXP: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: { advanceProgress: vi.fn().mockResolvedValue({ success: true, data: {} }) },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    createRefund: vi.fn(async (input: { amount: number; paymentIntentId: string }) => ({
      success: true,
      data: {
        refundId: 're_test', amount: input.amount, status: 'succeeded', currency: 'usd',
        paymentIntentId: input.paymentIntentId, chargeId: 'ch_test',
      },
    })),
    createTransfer: vi.fn(async (input: { amount: number }) => ({
      success: true,
      data: { transferId: 'tr_test', amount: input.amount },
    })),
    readTransferWitness: vi.fn(),
  },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { db, isInvariantViolation } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
import { StripeService } from '../../src/services/StripeService';
import { XPService } from '../../src/services/XPService';
import { enableControlledStripePaymentTestCohortV7 } from '../helpers/payment-underwriting-v7.js';

const mockQuery       = vi.mocked(db.query);
const mockIsInvariant = vi.mocked(isInvariantViolation);

beforeEach(() => {
  payoutDestination.mockImplementation(async (query,binding) => {
    const result=await query(
      'SELECT payouts_enabled,stripe_connect_id,stripe_connect_status FROM users WHERE id=$1',
      [binding.payoutRecipientUserId],
    );
    const row=result.rows[0];
    return row?.stripe_connect_id && row.payouts_enabled!==false
      ? { ready:true,stripeConnectId:row.stripe_connect_id,reason:'READY' }
      : { ready:false,stripeConnectId:null,reason:'PAYOUT_ACCOUNT_NOT_READY' };
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    task_id: 'task-1',
    amount: 5000,
    state: 'FUNDED',
    version: 0,
    platform_fee_cents: null,
    stripe_payment_intent_id: 'pi_test',
    stripe_transfer_id: null,
    stripe_refund_id: null,
    payout_provider: null,
    provider_transfer_id: null,
    provider_transfer_status: null,
    provider_transfer_paid_at: null,
    funded_at: new Date(),
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    poster_id: 'poster-1',
    worker_id: 'worker-1',
    ...overrides,
  };
}

function exactRefundBinding(overrides: Record<string, unknown> = {}) {
  return makeEscrow({
    id: 'esc-1', task_id: 'task-1', version: 1, state: 'FUNDED', amount: 5000,
    platform_fee_cents: null, stripe_payment_intent_id: 'pi_test',
    stripe_refund_id: null, stripe_transfer_id: null, payout_provider: null,
    provider_transfer_id: null, provider_transfer_status: null,
    provider_transfer_paid_at: null,
    ...overrides,
  });
}

function exactSucceededRefundMetadata() {
  return {
    event_type: 'exact_succeeded_refund_witness_v1', escrow_id: 'esc-1',
    task_id: 'task-1', canonical_state: 'FUNDED', payment_intent_id: 'pi_test',
    refund_id: 're_test', charge_id: 'ch_test', amount_cents: 5000,
    currency: 'usd', status: 'succeeded',
  };
}

function refundProviderClaimRow(escrowId: string, version: number) {
  return {
    claim_idempotency_key: `refund-provider-create-claim-v1:${escrowId}:${version}`,
    provider_idempotency_key: `hx-refund-claim-v1:${escrowId}:${version}`,
    provider_replay_deadline: new Date('2030-01-01T00:00:00.000Z'),
    exact: true,
  };
}

function makeWorkerKyc(overrides: Record<string, unknown> = {}) {
  return {
    payouts_enabled: true,
    stripe_connect_id: 'acct_test_123',
    stripe_connect_status: 'active',
    ...overrides,
  };
}

function installExactPartialRefundFixture() {
  const escrowRow = makeEscrow({
    state: 'LOCKED_DISPUTE',
    version: 1,
    task_id: 'task-1',
    amount: 5000,
    platform_fee_cents: null,
    stripe_payment_intent_id: 'pi_test',
    stripe_transfer_id: null,
    stripe_refund_id: null,
    refund_amount: null,
    release_amount: null,
  });
  const taskRow = {
    worker_id: 'worker-1',
    payout_recipient_user_id: null,
    provider_organization_id: null,
    provider_assignment_id: null,
    poster_id: 'poster-1',
  };
  const updated = makeEscrow({
    ...escrowRow,
    version: 2,
    state: 'REFUND_PARTIAL',
    stripe_transfer_id: 'tr_test',
    stripe_refund_id: 're_test',
    refund_amount: 1500,
    release_amount: 3500,
  });
  let claimMetadata: Record<string, unknown> | null = null;
  let refundCheckpointMetadata: Record<string, unknown> | null = null;
  let transferClaimMetadata: Record<string, unknown> | null = null;
  let transferCheckpointMetadata: Record<string, unknown> | null = null;
  let terminalTransitionMetadata: Record<string, unknown> | null = null;
  let terminalized = false;
  let insuranceReads = 0;
  let taskProgressReads = 0;
  let revenueReads = 0;

  mockQuery.mockImplementation(async (sqlInput: unknown, paramsInput?: unknown[]) => {
    const sql = String(sqlInput);
    const params = paramsInput ?? [];
    if (sql.includes('SELECT state') && sql.includes('FROM escrows WHERE id=$1')) {
      return {
        rows: [{
          state: terminalized ? 'REFUND_PARTIAL' : 'LOCKED_DISPUTE',
          provider_transfer_status: null,
        }],
        rowCount: 1,
      } as never;
    }
    if (sql.includes('FROM escrows') && sql.includes('FOR UPDATE')) {
      return { rows: [terminalized ? updated : escrowRow], rowCount: 1 } as never;
    }
    if (sql.includes('FROM tasks') && (sql.includes('worker_id') || sql.includes('t.worker_id'))) {
      return { rows: [taskRow], rowCount: 1 } as never;
    }
    if (sql.includes('SELECT payouts_enabled,stripe_connect_id,stripe_connect_status')) {
      return {
        rows: [{ payouts_enabled: true, stripe_connect_id: 'acct_test' }],
        rowCount: 1,
      } as never;
    }
    if (sql.includes('INSERT INTO escrow_events') && sql.includes('RETURNING metadata')) {
      const serialized = params.find((value) => typeof value === 'string' && value.startsWith('{'));
      const metadata = JSON.parse(String(serialized)) as Record<string, unknown>;
      if (metadata.event_type === 'partial_refund_provider_claim_v2') claimMetadata = metadata;
      if (metadata.event_type === 'partial_refund_provider_checkpoint_v3') {
        refundCheckpointMetadata = metadata;
      }
      if (metadata.event_type === 'partial_refund_transfer_claim_v1') {
        transferClaimMetadata = metadata;
      }
      if (metadata.event_type === 'partial_refund_transfer_checkpoint_v1') {
        transferCheckpointMetadata = metadata;
      }
      if (metadata.event_type === 'partial_refund_terminal_transition_v1') {
        terminalTransitionMetadata = metadata;
      }
      return { rows: [{ metadata }], rowCount: 1 } as never;
    }
    if (sql.includes('SELECT idempotency_key,metadata') && sql.includes('idempotency_key=ANY')) {
      const rows = [
        ['partial-refund-provider-claim:esc-1', claimMetadata],
        ['partial-refund-provider-checkpoint:esc-1', refundCheckpointMetadata],
        ['partial-refund-transfer-claim:esc-1', transferClaimMetadata],
        ['partial-refund-transfer-checkpoint:esc-1', transferCheckpointMetadata],
      ].filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null)
        .map(([idempotency_key, metadata]) => ({ idempotency_key, metadata }));
      return { rows, rowCount: rows.length } as never;
    }
    if (sql.includes('SELECT metadata FROM escrow_events')) {
      const key = String(params[1] ?? '');
      if (key === 'partial-refund-provider-claim:esc-1' && claimMetadata) {
        return { rows: [{ metadata: claimMetadata }], rowCount: 1 } as never;
      }
      if (key === 'partial-refund-provider-checkpoint:esc-1' && refundCheckpointMetadata) {
        return { rows: [{ metadata: refundCheckpointMetadata }], rowCount: 1 } as never;
      }
      if (key === 'partial-refund-transfer-checkpoint:esc-1' && transferCheckpointMetadata) {
        return { rows: [{ metadata: transferCheckpointMetadata }], rowCount: 1 } as never;
      }
      if (key === 'partial-refund-terminal-transition:esc-1:2' && terminalTransitionMetadata) {
        return { rows: [{ metadata: terminalTransitionMetadata }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    }
    if (sql.includes("SET state='REFUND_PARTIAL'")) {
      terminalized = true;
      return { rows: [updated], rowCount: 1 } as never;
    }
    if (sql.includes('FROM insurance_contributions')) {
      insuranceReads += 1;
      return insuranceReads === 1
        ? { rows: [], rowCount: 0 } as never
        : { rows: [{ id: 'insurance-1', contribution_cents: 70, contribution_percentage: 2 }], rowCount: 1 } as never;
    }
    if (sql.includes('SELECT progress_state FROM tasks')) {
      taskProgressReads += 1;
      return {
        rows: [{ progress_state: taskProgressReads === 1 ? 'COMPLETED' : 'CLOSED' }],
        rowCount: 1,
      } as never;
    }
    if (sql.includes('FROM revenue_ledger')) {
      revenueReads += 1;
      return revenueReads === 1
        ? { rows: [], rowCount: 0 } as never
        : { rows: [{
            id: 'revenue-1', event_type: 'platform_fee', user_id: 'poster-1',
            task_id: 'task-1', amount_cents: 525, currency: 'usd',
            gross_amount_cents: 3500, platform_fee_cents: 525,
            net_amount_cents: 2905, fee_basis_points: 1500,
            escrow_id: 'esc-1', stripe_transfer_id: 'tr_test',
            metadata: { event: 'escrow_partial_refund' },
          }], rowCount: 1 } as never;
    }
    if (sql.includes('FROM xp_ledger')) {
      return { rows: [], rowCount: 0 } as never;
    }
    if (sql.includes('INSERT INTO escrow_events')) {
      return { rows: [], rowCount: 1 } as never;
    }
    return { rows: [], rowCount: 0 } as never;
  });

  vi.mocked(StripeService.readTransferWitness).mockImplementation(async (transferId: string) => {
    if (!claimMetadata) throw new Error('partial-refund claim must precede transfer evidence');
    return {
      success: true,
      data: {
        provider: 'STRIPE' as const,
        transferId,
        amountCents: Number(claimMetadata.worker_settlement_net_cents),
        currency: 'usd',
        destinationAccountId: 'acct_test',
        reversed: false,
        amountReversedCents: 0,
        escrowId: 'esc-1',
        taskId: 'task-1',
        payoutRecipientUserId: 'worker-1',
      },
    };
  });
}

function releaseParams(escrowId:string,transferId:string) {
  return {
    escrowId,
    stripeTransferId:transferId,
    stripeTransferWitness:{
      provider:'STRIPE' as const,transferId,amountCents:4150,currency:'usd',
      destinationAccountId:'acct_test_123',reversed:false,amountReversedCents:0,
      escrowId,taskId:'task-1',payoutRecipientUserId:'worker-1',
    },
  };
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  enableControlledStripePaymentTestCohortV7();
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockIsInvariant.mockReturnValue(false);
  vi.mocked(XPService.awardXP).mockResolvedValue(undefined);
  // Make db.transaction call through so queries inside the transaction use the mockQuery queue
  vi.mocked((db as any).transaction).mockImplementation((fn: (q: typeof db.query) => Promise<unknown>) => fn(db.query));
});

// ===========================================================================
// getByTaskId
// ===========================================================================

describe('EscrowService.getByTaskId', () => {
  it('returns NOT_FOUND when no escrow exists for task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.getByTaskId('task-no-escrow');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.message).toContain('task-no-escrow');
  });

  it('returns the escrow when found', async () => {
    const escrow = makeEscrow({ task_id: 'task-1' });
    mockQuery.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

    const result = await EscrowService.getByTaskId('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.task_id).toBe('task-1');
  });

  it('returns DB_ERROR when query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection timeout') as never);

    const result = await EscrowService.getByTaskId('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ===========================================================================
// release — early return: escrow not found
// ===========================================================================

describe('EscrowService.release — escrow not found', () => {
  it('returns NOT_FOUND when escrow row does not exist', async () => {
    // 1st query: SELECT escrow by id → empty
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.release(releaseParams('nonexistent-esc','tr_test_branch'));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// release — task has no worker
// ===========================================================================

describe('EscrowService.release — no worker assigned', () => {
  it('returns INVALID_STATE when task has no worker_id', async () => {
    // 1st: SELECT escrow → found
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }],
      rowCount: 1,
    } as never);
    // 2nd: SELECT task → worker_id is null
    mockQuery.mockResolvedValueOnce({
      rows: [{ worker_id: null, price: 5000 }],
      rowCount: 1,
    } as never);

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('no assigned worker');
  });

  it('returns INVALID_STATE when task row not found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }],
      rowCount: 1,
    } as never);
    // task select → empty
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
  });
});

// ===========================================================================
// release — KYC gate: worker not found
// ===========================================================================

describe('EscrowService.release — KYC gate', () => {
  it('fails closed when the canonical payout destination is missing', async () => {
    // 1: escrow
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }],
      rowCount: 1,
    } as never);
    // 2: task
    mockQuery.mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never);
    // 3: worker KYC → not found
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('PAYOUT_ACCOUNT_NOT_READY');
  });

  it('returns INVALID_STATE when stripe_connect_id is missing', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeWorkerKyc({ stripe_connect_id: null })], rowCount: 1 } as never);

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('PAYOUT_ACCOUNT_NOT_READY');
  });

  it('returns INVALID_STATE when payouts_enabled is false', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeWorkerKyc({ payouts_enabled: false, stripe_connect_status: 'pending' })], rowCount: 1 } as never);

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('PAYOUT_ACCOUNT_NOT_READY');
  });
});

// ===========================================================================
// release — rowCount=0 after UPDATE (terminal / wrong state)
// ===========================================================================

describe('EscrowService.release — UPDATE rowCount=0 branches', () => {
  function setupReleaseThroughKyc() {
    // escrow, task, worker KYC (all pass)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeWorkerKyc()], rowCount: 1 } as never);
  }

  it('returns ESCROW_TERMINAL when escrow is in terminal state after failed UPDATE', async () => {
    setupReleaseThroughKyc();
    // UPDATE returns rowCount=0 → fallback getById: returns RELEASED (terminal)
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE fails
      .mockResolvedValueOnce({                                    // getById
        rows: [makeEscrow({ state: 'RELEASED', released_at: new Date() })],
        rowCount: 1,
      } as never);

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HX002'); // ErrorCodes.ESCROW_TERMINAL
  });

  it('returns INVALID_STATE when escrow is in wrong non-terminal state after failed UPDATE', async () => {
    setupReleaseThroughKyc();
    // UPDATE returns rowCount=0 → fallback getById: returns PENDING (non-terminal, non-target)
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE fails
      .mockResolvedValueOnce({
        rows: [makeEscrow({ state: 'PENDING' })],
        rowCount: 1,
      } as never);

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('Cannot release escrow');
  });
});

// ===========================================================================
// release — XP error paths
// ===========================================================================

describe('EscrowService.release — XP error handling', () => {
  function setupSuccessfulRelease() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeWorkerKyc()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED' })], rowCount: 1 } as never) // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // logEscrowEvent INSERT
  }

  it('succeeds when XP award throws XP-TAX-BLOCK (continue, escrow still released)', async () => {
    setupSuccessfulRelease();
    vi.mocked(XPService.awardXP).mockRejectedValueOnce(
      new Error('XP-TAX-BLOCK: offline payment tax unpaid')
    );

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    // Escrow release itself still succeeds — XP block is non-fatal
    expect(result.success).toBe(true);
  });

  it('succeeds when XP award throws an unexpected error (continue, escrow still released)', async () => {
    setupSuccessfulRelease();
    vi.mocked(XPService.awardXP).mockRejectedValueOnce(
      new Error('Unexpected XP DB error')
    );

    const result = await EscrowService.release(releaseParams('esc-1','tr_test_branch'));

    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// refund — rowCount=0 branches
// ===========================================================================

describe('EscrowService.refund — T2 convergence branches', () => {
  it('rolls back the exact claim resolution when the terminal UPDATE misses', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [exactRefundBinding()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [refundProviderClaimRow('esc-1', 1)], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ allowed: true }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ metadata: exactSucceededRefundMetadata() }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [exactRefundBinding()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ exact: true }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ set_config: 'esc-1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.refund({ escrowId: 'esc-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });

  it('returns ESCROW_TERMINAL when getById returns a terminal-state escrow', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [exactRefundBinding()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [refundProviderClaimRow('esc-1', 1)], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ allowed: true }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ metadata: exactSucceededRefundMetadata() }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [exactRefundBinding({ state: 'RELEASED' })], rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ exact: true }], rowCount: 1 } as never); // durable recovery event

    const result = await EscrowService.refund({ escrowId: 'esc-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HX002'); // ErrorCodes.ESCROW_TERMINAL
  });

  it('returns INVALID_STATE when getById returns escrow in PENDING state', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [exactRefundBinding()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [refundProviderClaimRow('esc-1', 1)], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ allowed: true }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ metadata: exactSucceededRefundMetadata() }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [exactRefundBinding({ state: 'PENDING', version: 2 })], rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ exact: true }], rowCount: 1 } as never); // durable recovery event

    const result = await EscrowService.refund({ escrowId: 'esc-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('Cannot refund');
  });
});

// ===========================================================================
// lockForDispute — rowCount=0 branch
// ===========================================================================

describe('EscrowService.lockForDispute — rowCount=0', () => {
  it('returns INVALID_STATE when escrow is not FUNDED (e.g. PENDING)', async () => {
    // Window check — no rows (skips time gate)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // dup dispute check
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
    // UPDATE rowCount=0
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getById → PENDING
    mockQuery.mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never);

    const result = await EscrowService.lockForDispute('esc-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('expected FUNDED');
  });

  it('returns getById error when getById fails', async () => {
    // Window check — no rows (skips time gate)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // dup dispute check
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
    // UPDATE rowCount=0
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getById DB error
    mockQuery.mockRejectedValueOnce(new Error('db error') as never);

    const result = await EscrowService.lockForDispute('esc-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ===========================================================================
// partialRefund — validation and rowCount=0 branches
// ===========================================================================

describe('EscrowService.partialRefund', () => {
  it('returns INVALID_STATE when worker + poster percentages do not sum to 100', async () => {
    const result = await EscrowService.partialRefund({
      escrowId: 'esc-1',
      workerPercent: 60,
      posterPercent: 30, // 60 + 30 = 90 ≠ 100
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('sum to 100');
  });

  it('returns INVALID_STATE when escrow is not LOCKED_DISPUTE', async () => {
    // R22 Stripe-first pattern: Transaction 1 (read-lock) reads the escrow state and
    // returns early with INVALID_STATE if it is not LOCKED_DISPUTE — no further queries run.
    //
    // Only 1 query consumed: SELECT ... FOR UPDATE (returns FUNDED row → early exit)
    mockQuery.mockResolvedValueOnce({
      rows: [makeEscrow({ state: 'FUNDED', version: 1, task_id: 'task-1', amount: 5000, stripe_payment_intent_id: 'pi_test' })],
      rowCount: 1,
    } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [makeEscrow({ state: 'FUNDED', version: 1, task_id: 'task-1', amount: 5000, stripe_payment_intent_id: 'pi_test' })],
      rowCount: 1,
    } as never);

    const result = await EscrowService.partialRefund({
      escrowId: 'esc-1',
      workerPercent: 70,
      posterPercent: 30,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('expected LOCKED_DISPUTE');
  });

  it('fails closed before Stripe when a canonical quote split would be partially disputed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ state: 'LOCKED_DISPUTE' }], rowCount: 1 } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [makeEscrow({
        state: 'LOCKED_DISPUTE',
        version: 1,
        task_id: 'task-1',
        amount: 5000,
        platform_fee_cents: 1250,
        stripe_payment_intent_id: 'pi_test',
      })],
      rowCount: 1,
    } as never);

    const result = await EscrowService.partialRefund({
      escrowId: 'esc-1',
      workerPercent: 70,
      posterPercent: 30,
    });

    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(result.error?.message).toContain('Canonical quote partial payout');
  });

  it('succeeds when escrow is LOCKED_DISPUTE and percentages sum to 100', async () => {
    installExactPartialRefundFixture();

    const result = await EscrowService.partialRefund({
      escrowId: 'esc-1',
      workerPercent: 70,
      posterPercent: 30,
    });

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('REFUND_PARTIAL');
    expect(vi.mocked(StripeService.createRefund)).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_test', amount: 1500 }),
    );
    expect(vi.mocked(StripeService.createTransfer)).toHaveBeenCalledWith(
      expect.objectContaining({
        escrowId: 'esc-1', taskId: 'task-1', workerId: 'worker-1',
        workerStripeAccountId: 'acct_test', amount: 2905,
      }),
    );
  });
});
