/**
 * EscrowService Unit Tests
 *
 * Tests state machine integrity, INV-2 enforcement, terminal state rejection,
 * amount validation, and gamification integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const payoutDestination = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// The db mock exposes both `query` (for direct queries) and `transaction`
// (for methods wrapped in db.transaction()). The transaction mock calls the
// provided callback with the same `query` spy so existing mockResolvedValueOnce
// sequences work seamlessly inside and outside transactions.
vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  taskLogger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: { recordEarnings: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: { recordOfflinePayment: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: {
    awardXP: vi.fn().mockResolvedValue(undefined),
    clawbackXP: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: { advanceProgress: vi.fn().mockResolvedValue({ success: true, data: {} }) },
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
    cancelRefund: vi.fn().mockResolvedValue({ success: true, data: { refundId: 're_test', status: 'cancelled' } }),
    createTransferReversal: vi.fn().mockResolvedValue({ success: true, data: { reversalId: 'pyr_test' } }),
  },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
import { EarnedVerificationUnlockService } from '../../src/services/EarnedVerificationUnlockService';
import { XPService } from '../../src/services/XPService';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService.js';
import { RevenueService } from '../../src/services/RevenueService';
import { StripeService } from '../../src/services/StripeService';
import { enableControlledStripePaymentTestCohortV7 } from '../helpers/payment-underwriting-v7.js';

const mockDb = vi.mocked(db);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);
const mockIsUniqueViolation = vi.mocked(isUniqueViolation);
const mockGetErrorMessage = vi.mocked(getErrorMessage);

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    task_id: 'task-1',
    version: 0,
    amount: 5000,
    state: 'PENDING',
    platform_fee_cents: null,
    stripe_payment_intent_id: null,
    stripe_transfer_id: null,
    stripe_refund_id: null,
    payout_provider: null,
    provider_transfer_id: null,
    provider_transfer_status: null,
    provider_transfer_paid_at: null,
    funded_at: null,
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function exactSucceededRefundMetadata(input: {
  canonicalState?: string;
  amountCents?: number;
} = {}) {
  return {
    event_type: 'exact_succeeded_refund_witness_v1',
    escrow_id: 'esc-1',
    task_id: 'task-1',
    canonical_state: input.canonicalState ?? 'FUNDED',
    payment_intent_id: 'pi_test',
    refund_id: 're_test',
    charge_id: 'ch_test',
    amount_cents: input.amountCents ?? 5000,
    currency: 'usd',
    status: 'succeeded',
  };
}

function exactRefundBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1', task_id: 'task-1', version: 0, state: 'FUNDED', amount: 5000,
    platform_fee_cents: null, stripe_payment_intent_id: 'pi_test',
    stripe_refund_id: null, stripe_transfer_id: null, payout_provider: null,
    provider_transfer_id: null, provider_transfer_status: null,
    provider_transfer_paid_at: null,
    ...overrides,
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

interface PartialRefundFixture {
  workerPercent?: number;
  version?: number;
  existingTransferId?: string | null;
  existingRefundId?: string | null;
  workerId?: string;
  payoutRecipientUserId?: string | null;
  posterId?: string | null;
  destinationAccountId?: string;
}

function installPartialRefundFixture(input: PartialRefundFixture = {}) {
  const workerPercent = input.workerPercent ?? 60;
  const version = input.version ?? 0;
  const workerId = input.workerId ?? 'worker-1';
  const payoutRecipientUserId = input.payoutRecipientUserId ?? workerId;
  const destinationAccountId = input.destinationAccountId ?? 'acct_test';
  const existingTransferId = input.existingTransferId ?? null;
  const existingRefundId = input.existingRefundId ?? null;
  const escrowRow = {
    version,
    state: 'LOCKED_DISPUTE',
    task_id: 'task-1',
    amount: 5000,
    platform_fee_cents: null,
    stripe_payment_intent_id: 'pi_test',
    stripe_transfer_id: existingTransferId,
    stripe_refund_id: existingRefundId,
    refund_amount: null,
    release_amount: null,
  };
  const taskRow = {
    worker_id: workerId,
    payout_recipient_user_id: input.payoutRecipientUserId ?? null,
    provider_organization_id: null,
    provider_assignment_id: null,
    poster_id: input.posterId ?? null,
  };
  const updated = makeEscrow({
    ...escrowRow,
    version: version + 1,
    state: 'REFUND_PARTIAL',
    stripe_transfer_id: existingTransferId ?? 'tr_test',
    stripe_refund_id: existingRefundId ?? 're_test',
    refund_amount: Math.round(5000 * ((100 - workerPercent) / 100)),
    release_amount: Math.round(5000 * (workerPercent / 100)),
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

  mockDb.query.mockImplementation(async (sqlInput: unknown, paramsInput?: unknown[]) => {
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
        rows: [{ payouts_enabled: true, stripe_connect_id: destinationAccountId }],
        rowCount: 1,
      } as never;
    }
    if (sql.includes('INSERT INTO escrow_events') && sql.includes('RETURNING metadata')) {
      const serialized = params.find((value) => typeof value === 'string' && value.startsWith('{'));
      const metadata = JSON.parse(String(serialized)) as Record<string, unknown>;
      if (metadata.event_type === 'partial_refund_provider_claim_v2') claimMetadata = metadata;
      if (metadata.event_type === 'partial_refund_transfer_claim_v1') {
        transferClaimMetadata = metadata;
      }
      if (metadata.event_type === 'partial_refund_provider_checkpoint_v3') {
        refundCheckpointMetadata = metadata;
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
      if (key === 'partial-refund-provider-claim:esc-1') {
        return claimMetadata
          ? { rows: [{ metadata: claimMetadata }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
      }
      if (key === 'partial-refund-transfer-checkpoint:esc-1') {
        return transferCheckpointMetadata
          ? { rows: [{ metadata: transferCheckpointMetadata }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
      }
      if (key === 'partial-refund-provider-checkpoint:esc-1' && refundCheckpointMetadata) {
        return { rows: [{ metadata: refundCheckpointMetadata }], rowCount: 1 } as never;
      }
      if (key === 'partial-refund-provider-checkpoint:esc-1' && existingRefundId && claimMetadata) {
        const metadata = {
          ...claimMetadata,
          event_type: 'partial_refund_provider_checkpoint_v3',
          stripe_refund_id: existingRefundId,
          stripe_refund_amount_cents: claimMetadata.poster_refund_amount_cents,
          stripe_refund_status: 'succeeded',
          stripe_refund_currency: 'usd',
          stripe_refund_payment_intent_id: 'pi_test',
          stripe_refund_charge_id: 'ch_existing',
        };
        refundCheckpointMetadata = metadata;
        return { rows: [{ metadata }], rowCount: 1 } as never;
      }
      if (key === `partial-refund-terminal-transition:esc-1:${version + 1}`) {
        return terminalTransitionMetadata
          ? { rows: [{ metadata: terminalTransitionMetadata }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
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
        : { rows: [{ id: 'insurance-1', contribution_cents: 60, contribution_percentage: 2 }], rowCount: 1 } as never;
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
      const releaseAmount = Math.round(5000 * (workerPercent / 100));
      const fee = Math.round(releaseAmount * 0.20);
      const insurance = Math.round(releaseAmount * 0.02);
      return revenueReads === 1
        ? { rows: [], rowCount: 0 } as never
        : { rows: [{
            id: 'revenue-1', event_type: 'platform_fee',
            user_id: (input.posterId ?? null) ?? workerId, task_id: 'task-1',
            amount_cents: fee, currency: 'usd', gross_amount_cents: releaseAmount,
            platform_fee_cents: fee, net_amount_cents: releaseAmount - fee - insurance,
            fee_basis_points: 2000, escrow_id: 'esc-1',
            stripe_transfer_id: existingTransferId ?? 'tr_test',
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
        destinationAccountId,
        reversed: false,
        amountReversedCents: 0,
        escrowId: 'esc-1',
        taskId: 'task-1',
        payoutRecipientUserId,
      },
    };
  });
}

function stripeReleaseParams(
  transferId:string,
  overrides:Partial<{
    escrowId:string;taskId:string;amountCents:number;destinationAccountId:string;
    payoutRecipientUserId:string;
  }> = {},
) {
  const escrowId=overrides.escrowId ?? 'esc-1';
  const taskId=overrides.taskId ?? 'task-1';
  const payoutRecipientUserId=overrides.payoutRecipientUserId ?? 'worker-1';
  return {
    escrowId,
    stripeTransferId:transferId,
    stripeTransferWitness:{
      provider:'STRIPE' as const,
      transferId,
      amountCents:overrides.amountCents ?? 3900,
      currency:'usd',
      destinationAccountId:overrides.destinationAccountId ?? 'acct_test',
      reversed:false,
      amountReversedCents:0,
      escrowId,
      taskId,
      payoutRecipientUserId,
    },
  };
}

beforeEach(() => {
  enableControlledStripePaymentTestCohortV7();
  vi.clearAllMocks();
  // Early-return authority and error-path tests can leave one-time query
  // responses queued. Reset them so one escrow scenario cannot contaminate
  // the next scenario while preserving the transaction mock implementation.
  mockDb.query.mockReset();
  mockIsInvariantViolation.mockReturnValue(false);
  mockIsUniqueViolation.mockReturnValue(false);
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

// ===========================================================================
// TESTS
// ===========================================================================

describe('EscrowService', () => {
  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------
  describe('getById', () => {
    it('returns escrow when found', async () => {
      const escrow = makeEscrow();
      mockDb.query.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

      const result = await EscrowService.getById('esc-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.id).toBe('esc-1');
    });

    it('returns NOT_FOUND when escrow missing', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.getById('esc-missing');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection timeout'));

      const result = await EscrowService.getById('esc-1');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DB_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------
  describe('create', () => {
    it('creates escrow with valid amount', async () => {
      const escrow = makeEscrow({ amount: 5000 });
      mockDb.query.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

      const result = await EscrowService.create({ taskId: 'task-1', amount: 5000 });
      expect(result.success).toBe(true);
    });

    it('rejects zero amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: 0 });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('positive integer');
    });

    it('rejects negative amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: -100 });
      expect(result.success).toBe(false);
    });

    it('rejects float amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: 49.99 });
      expect(result.success).toBe(false);
    });

    it('returns DUPLICATE on unique violation', async () => {
      const err = Object.assign(new Error('dup'), { code: '23505' });
      mockDb.query.mockRejectedValueOnce(err);
      mockIsUniqueViolation.mockReturnValueOnce(true);

      const result = await EscrowService.create({ taskId: 'task-1', amount: 5000 });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DUPLICATE');
    });
  });

  // -------------------------------------------------------------------------
  // fund
  // -------------------------------------------------------------------------
  // fund() is now wrapped in db.transaction() with SELECT FOR UPDATE then UPDATE.
  // The transaction mock calls the callback with the same mockDb.query spy, so
  // mockResolvedValueOnce sequences are consumed in order:
  //   1st call: SELECT state, version ... FOR UPDATE  → returns lock row
  //   2nd call: UPDATE escrows ... RETURNING *        → returns updated row
  // -------------------------------------------------------------------------
  describe('fund', () => {
    it('funds escrow from PENDING state', async () => {
      const funded = makeEscrow({ state: 'FUNDED', funded_at: new Date() });
      // 1st: SELECT FOR UPDATE → lock row with state=PENDING, version=0
      mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'PENDING', version: 0 }], rowCount: 1 } as never);
      // 2nd: cross-escrow PI dedup check → no conflict (happy path)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // 3rd: UPDATE → funded row
      mockDb.query.mockResolvedValueOnce({ rows: [funded], rowCount: 1 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('FUNDED');
    });

    it('fails when not in PENDING state', async () => {
      // 1st: SELECT FOR UPDATE → row with wrong state
      mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'FUNDED', version: 1 }], rowCount: 1 } as never);
      // 2nd: cross-escrow PI dedup check → no conflict (runs before the state check)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('expected PENDING');
    });

    it('returns NOT_FOUND when escrow does not exist', async () => {
      // SELECT FOR UPDATE → no rows → early return, no PI dedup check needed
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // release (INV-2 enforcement)
  // -------------------------------------------------------------------------
  describe('release', () => {
    it('releases escrow from FUNDED state (happy path)', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never) // SELECT escrow
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)   // SELECT task
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never); // UPDATE

      const result = await EscrowService.release(stripeReleaseParams('tr_123'));
      expect(result.success).toBe(true);

      // Verify gamification: recordEarnings called with net payout
      // F54-2: insurance = 2% of gross (not net)
      // gross=5000, fallback margin=1000, netBeforeInsurance=4000, insurance=100, final=3900
      expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
        'worker-1', 'task-1', 'esc-1', 3900
      );

      // Verify XP award: price / 10
      expect(XPService.awardXP).toHaveBeenCalledWith({
        userId: 'worker-1', taskId: 'task-1', escrowId: 'esc-1', baseXP: 500,
      });

      // Verify self-insurance contribution: F54-2: 2% of GROSS (not net)
      // gross=5000, insurance=Math.round(5000*0.02)=100
      expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
        'task-1', 'worker-1', 100,
      );
    });

    it('routes a stored pre-D1 transfer without task_id to reconciliation until its cohort is admitted', async () => {
      const escrowRow = {
        id:'esc-1',task_id:'task-1',amount:5000,platform_fee_cents:null,
        state:'FUNDED',version:3,stripe_transfer_id:'tr_legacy',
      };
      const taskRow = { worker_id:'worker-1',price:5000 };
      const workerKycRow = {
        payouts_enabled:true,stripe_connect_id:'acct_test',stripe_connect_status:'complete',
      };
      mockDb.query
        .mockResolvedValueOnce({ rows:[escrowRow],rowCount:1 } as never)
        .mockResolvedValueOnce({ rows:[taskRow],rowCount:1 } as never)
        .mockResolvedValueOnce({ rows:[workerKycRow],rowCount:1 } as never);

      const current = stripeReleaseParams('tr_legacy');
      const result = await EscrowService.release({
        ...current,
        stripeTransferWitness:{ ...current.stripeTransferWitness,taskId:null },
      });

      expect(result).toMatchObject({ success:false,error:{ code:'INVALID_STATE' } });
      expect(mockDb.query.mock.calls.map(([sql]) => String(sql)).join('\n'))
        .not.toMatch(/UPDATE\s+escrows\s+SET\s+state='RELEASED'/i);
    });

    it('rejects a newly presented transfer without task_id even when its other metadata matches', async () => {
      const escrowRow = {
        id:'esc-1',task_id:'task-1',amount:5000,platform_fee_cents:null,
        state:'FUNDED',version:3,stripe_transfer_id:null,
      };
      const taskRow = { worker_id:'worker-1',price:5000 };
      const workerKycRow = {
        payouts_enabled:true,stripe_connect_id:'acct_test',stripe_connect_status:'complete',
      };
      mockDb.query
        .mockResolvedValueOnce({ rows:[escrowRow],rowCount:1 } as never)
        .mockResolvedValueOnce({ rows:[taskRow],rowCount:1 } as never)
        .mockResolvedValueOnce({ rows:[workerKycRow],rowCount:1 } as never);

      const current = stripeReleaseParams('tr_unbound');
      const result = await EscrowService.release({
        ...current,
        stripeTransferWitness:{ ...current.stripeTransferWitness,taskId:null },
      });

      expect(result).toMatchObject({ success:false,error:{ code:'INVALID_STATE' } });
      expect(mockDb.query.mock.calls.map(([sql]) => String(sql)).join('\n'))
        .not.toMatch(/UPDATE\s+escrows\s+SET\s+state='RELEASED'/i);
    });

    it('validates the Service Business payee while preserving fulfiller safety and performance attribution', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = {
        worker_id: 'crew-worker-1', payout_recipient_user_id: 'business-payee-1',
        provider_organization_id: 'provider-org-1', price: 5000,
      };
      const payeeKyc = { payouts_enabled: true, stripe_connect_id: 'acct_business', stripe_connect_status: 'complete' };
      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [payeeKyc], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED' })], rowCount: 1 } as never);

      const result = await EscrowService.release(stripeReleaseParams('tr_business', {
        destinationAccountId:'acct_business',payoutRecipientUserId:'business-payee-1',
      }));

      expect(result.success).toBe(true);
      const kycQuery = mockDb.query.mock.calls.find(([sql]) =>
        String(sql).includes('stripe_connect_status'));
      expect(kycQuery?.[1]).toEqual(['business-payee-1']);
      expect(EarnedVerificationUnlockService.recordEarnings).not.toHaveBeenCalled();
      expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
        'task-1','crew-worker-1',100,
      );
      expect(XPService.awardXP).toHaveBeenCalledWith(expect.objectContaining({
        userId:'crew-worker-1',taskId:'task-1',escrowId:'esc-1',
      }));
    });

    it('rejects a stale transfer witness after the payout destination rotates', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows:[{ id:'esc-1',task_id:'task-1',amount:5000,state:'FUNDED',version:4,
            platform_fee_cents:null,stripe_transfer_id:null }],rowCount:1,
        } as never)
        .mockResolvedValueOnce({
          rows:[{ worker_id:'worker-1',payout_recipient_user_id:null,
            provider_organization_id:null,provider_assignment_id:null,price:5000 }],rowCount:1,
        } as never)
        .mockResolvedValueOnce({
          rows:[{ payouts_enabled:true,stripe_connect_id:'acct_rotated' }],rowCount:1,
        } as never);

      const result = await EscrowService.release(stripeReleaseParams('tr_stale_destination'));

      expect(result).toMatchObject({ success:false,error:{ code:'INVALID_STATE' } });
      expect(mockDb.query.mock.calls.map(([sql]) => String(sql)).join('\n'))
        .not.toMatch(/UPDATE\s+escrows\s+SET\s+state='RELEASED'/i);
      expect(EarnedVerificationUnlockService.recordEarnings).not.toHaveBeenCalled();
      expect(XPService.awardXP).not.toHaveBeenCalled();
    });

    it('continues release even if self-insurance contribution fails', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

      vi.mocked(SelfInsurancePoolService.recordContribution).mockRejectedValueOnce(
        new Error('DB pool unreachable')
      );

      const result = await EscrowService.release(stripeReleaseParams('tr_test_svc'));
      // Payout must still succeed despite insurance failure
      expect(result.success).toBe(true);
    });

    it('returns INV_2_VIOLATION when trigger fires HX201', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
        .mockRejectedValueOnce(Object.assign(new Error('INV-2'), { code: 'HX201' }));

      mockIsInvariantViolation.mockReturnValueOnce(true);
      mockGetErrorMessage.mockReturnValueOnce('INV-2 VIOLATION');

      const result = await EscrowService.release(stripeReleaseParams('tr_test_svc'));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('HX201'); // ErrorCodes.INV_2_VIOLATION = 'HX201'
    });

    it('returns ESCROW_TERMINAL when already released', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE returns 0
        .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED' })], rowCount: 1 } as never); // getById

      const result = await EscrowService.release(stripeReleaseParams('tr_test_svc'));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('HX002'); // ErrorCodes.ESCROW_TERMINAL = 'HX002'
    });

    it('returns NOT_FOUND when escrow does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.release(stripeReleaseParams('tr_test_svc', {
        escrowId:'esc-missing',
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns INVALID_STATE when task has no worker', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ worker_id: null, price: 5000 }], rowCount: 1 } as never);

      const result = await EscrowService.release(stripeReleaseParams('tr_test_svc'));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('no assigned worker');
    });

    it('continues release even if XP award fails', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

      vi.mocked(XPService.awardXP).mockRejectedValueOnce(new Error('XP failure'));

      const result = await EscrowService.release(stripeReleaseParams('tr_test_svc'));
      expect(result.success).toBe(true);
    });

    it('blocks admin force-release before terminal state or economic effects', async () => {
      // adminOverride=true, worker has no Stripe Connect ID → adminManualPayoutRequired=true
      // The normal transfer.created webhook will never fire, so platform_fee must be logged here.
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerNoStripeRow = { stripe_connect_id: null }; // no Connect account → adminManualPayoutRequired=true
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never) // SELECT escrow FOR UPDATE
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)   // SELECT task
        .mockResolvedValueOnce({ rows: [workerNoStripeRow], rowCount: 1 } as never) // adminOverride: check stripe_connect_id
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never); // UPDATE → RELEASED

      const result = await EscrowService.release({
        escrowId: 'esc-1',
        adminOverride: true,
        reason: 'Admin force release',
      });

      expect(result).toMatchObject({ success:false,error:{ code:'INVALID_STATE' } });
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(RevenueService.logEvent)).not.toHaveBeenCalled();
      expect(EarnedVerificationUnlockService.recordEarnings).not.toHaveBeenCalled();
      expect(SelfInsurancePoolService.recordContribution).not.toHaveBeenCalled();
      expect(XPService.awardXP).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // PR3 value-pinning: admin_override_release platform_fee attribution (F-23)
    // These pin the EXACT logEvent payload (not just "was called"), because the
    // DB provides no backstop for ledger attribution. The poster-attribution
    // assertion is RED on pre-fix source (line 641 evaluates to `undefined`,
    // serialized to SQL NULL) and GREEN after the Option B source fix.
    // -----------------------------------------------------------------------
    it('blocks poster-attributed admin economics without provider evidence', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      // poster_id seeded — production tasks.poster_id is NOT NULL
      const taskRow = { worker_id: 'worker-1', price: 5000, payment_method: 'escrow', poster_id: 'poster-9' };
      const workerNoStripeRow = { stripe_connect_id: null }; // → adminManualPayoutRequired=true
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)        // SELECT escrow FOR UPDATE
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)          // SELECT task
        .mockResolvedValueOnce({ rows: [workerNoStripeRow], rowCount: 1 } as never)// adminOverride: stripe_connect_id
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);        // UPDATE → RELEASED

      const result = await EscrowService.release({ escrowId: 'esc-1', adminOverride: true, reason: 'Admin force release' });
      expect(result).toMatchObject({ success:false,error:{ code:'INVALID_STATE' } });
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(RevenueService.logEvent)).not.toHaveBeenCalled();
    });

    it('blocks admin force-release even when the calculated fee rounds to zero', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 1, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 1, payment_method: 'escrow', poster_id: 'poster-9' };
      const workerNoStripeRow = { stripe_connect_id: null };
      const released = makeEscrow({ state: 'RELEASED', amount: 1 });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerNoStripeRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

      const result = await EscrowService.release({
        escrowId: 'esc-1',
        adminOverride: true,
        reason: 'Documented administrator payout decision',
      });
      expect(result).toMatchObject({ success:false,error:{ code:'INVALID_STATE' } });
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(RevenueService.logEvent)).not.toHaveBeenCalled();
    });

    it('PR3 F-10: normal release writes zero platform_fee via RevenueService.logEvent', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000, payment_method: 'escrow', poster_id: 'poster-9' };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

      const result = await EscrowService.release(stripeReleaseParams('tr_123'));
      expect(result.success).toBe(true);
      // F-10: payment-worker's handleTransferCreated is the sole platform_fee source on normal release
      expect(vi.mocked(RevenueService.logEvent)).not.toHaveBeenCalled();
    });

    // DEFENSIVE / SCHEMA-INVALID: production tasks.poster_id is NOT NULL, so a missing
    // poster models only a corrupt/legacy row. Asserts the F-23 worker fallback and that
    // attribution never regresses to null. Not a production proof — do not over-weight.
    it('blocks admin force-release for schema-invalid legacy rows too', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000, payment_method: 'escrow', poster_id: null };
      const workerNoStripeRow = { stripe_connect_id: null };
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerNoStripeRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

      const result = await EscrowService.release({
        escrowId: 'esc-1',
        adminOverride: true,
        reason: 'Documented administrator payout decision',
      });
      expect(result).toMatchObject({ success:false,error:{ code:'INVALID_STATE' } });
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(RevenueService.logEvent)).not.toHaveBeenCalled();
    });

    it('rejects admin override release regardless of reason text', async () => {
      const result = await EscrowService.release({ escrowId: 'esc-1', adminOverride: true });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toContain('cannot create RELEASED economics');
      }
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // refund
  // -------------------------------------------------------------------------
  describe('refund', () => {
    it('refunds from FUNDED state', async () => {
      const refunded = makeEscrow({
        state: 'REFUNDED',
        refund_transition_event_exact: true,
        event_key: 'escrow-refunded-transition-v1:esc-1:1',
        event_metadata: {},
      });
      // Transaction callback query sequence:
      //   T1 — 1st: SELECT ... FOR UPDATE (escrow pre-check — now includes stripe_payment_intent_id + amount)
      //   T1 — 2nd: SELECT worker_id, state FROM tasks (task state check moved inside transaction — LL4)
      //   [Stripe createRefund called outside DB transactions]
      //   T2 — 3rd: SELECT id, version, state FROM escrows FOR UPDATE NOWAIT (F-05: re-read version under lock)
      //   T2 — 4th: UPDATE escrows RETURNING * (state transition using freshly-locked version)
      //   outside — 5th: INSERT INTO escrow_events (logEscrowEvent)
      mockDb.query
        .mockResolvedValueOnce({ rows: [exactRefundBinding()], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never) // T1: exact unassigned task
        .mockResolvedValueOnce({ rows: [refundProviderClaimRow('esc-1', 0)], rowCount: 1 } as never) // T1: immutable provider-call claim
        .mockResolvedValueOnce({ rows: [{ allowed: true }], rowCount: 1 } as never) // pre-provider DB-clock claim revalidation
        .mockResolvedValueOnce({ rows: [{ metadata: exactSucceededRefundMetadata() }], rowCount: 1 } as never) // durable exact provider witness
        .mockResolvedValueOnce({ rows: [exactRefundBinding()], rowCount: 1 } as never) // T2: exact FOR UPDATE NOWAIT re-read
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never) // T2: exact task binding
        .mockResolvedValueOnce({ rows: [{ exact: true }], rowCount: 1 } as never) // T2: immutable claim resolution
        .mockResolvedValueOnce({ rows: [{ set_config: 'esc-1' }], rowCount: 1 } as never) // T2: transaction-local trigger authority
        .mockResolvedValueOnce({ rows: [refunded], rowCount: 1 } as never); // T2: UPDATE + transition witness

      const result = await EscrowService.refund({ escrowId: 'esc-1' });
      expect(result.success, JSON.stringify(result)).toBe(true);
      if (result.success) expect(result.data.state).toBe('REFUNDED');
    });

    it('blocks refund when task is in ACCEPTED state (LL4 race fix)', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', version: 0, state: 'FUNDED', stripe_payment_intent_id: null, amount: 5000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', state: 'ACCEPTED' }], rowCount: 1 } as never); // task assigned

      const result = await EscrowService.refund({ escrowId: 'esc-1' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('accepted by a worker');
    });

    it('returns INVALID_STATE when the terminal refund is already visible at preflight', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [exactRefundBinding({ state: 'REFUNDED', stripe_refund_id: 're_test' })],
        rowCount: 1,
      } as never);

      const result = await EscrowService.refund({ escrowId: 'esc-1' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
    });
  });

  // -------------------------------------------------------------------------
  // lockForDispute
  // -------------------------------------------------------------------------
  describe('lockForDispute', () => {
    it('locks from FUNDED state', async () => {
      const locked = makeEscrow({ state: 'LOCKED_DISPUTE' });
      // Window check returns no rows (no completed_at — window guard skipped)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Bug 2 fix: existing dispute count check — 0 open disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
      // UPDATE escrows SET state = 'LOCKED_DISPUTE'
      mockDb.query.mockResolvedValueOnce({ rows: [locked], rowCount: 1 } as never);
      // logEscrowEvent INSERT
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await EscrowService.lockForDispute('esc-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('LOCKED_DISPUTE');
    });

    it('fails when not in FUNDED state', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // window check
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never) // Bug 2 fix: existing dispute check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE — 0 rows
        .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never); // getById

      const result = await EscrowService.lockForDispute('esc-1');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('expected FUNDED');
    });
  });

  // -------------------------------------------------------------------------
  // partialRefund
  // -------------------------------------------------------------------------
  describe('partialRefund', () => {
    it('partial refunds from LOCKED_DISPUTE with valid percentages', async () => {
      installPartialRefundFixture();

      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });
      expect(result.success, JSON.stringify(result)).toBe(true);

      // Verify Stripe was called with the correct amounts (60% worker, 40% poster)
      expect(vi.mocked(MockStripe.createTransfer)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(MockStripe.createRefund)).toHaveBeenCalledTimes(1);

      // Verify the terminalizing UPDATE uses lockedVersion (from NOWAIT re-read) not stale T1 version
      const updateCalls = mockDb.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes("SET state='REFUND_PARTIAL'")
      );
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0][1]).toEqual([
        'esc-1', 0, 'task-1', 5000, null, 'pi_test', null, null,
        'tr_test', 're_test', 2000, 3000,
      ]);
    });

    it('REVIEW FIX (PR242): withholds 2% self-insurance (gross basis) and records the pool contribution', async () => {
      // 60/40 split on a $50 escrow: workerCents = round(5000×0.60) = 3000.
      // fallback margin = round(3000×0.20) = 600 → net = 2400.
      // insurance = round(3000×0.02) = 60 (GROSS basis, matching full release & worker queue).
      // worker transfer = 2400 − 60 = 2340. pool contribution = 60.
      installPartialRefundFixture();

      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });
      expect(result.success).toBe(true);

      // Worker transfer is net-of-fee MINUS insurance
      const transferArg = vi.mocked(MockStripe.createTransfer).mock.calls[0][0] as { amount: number };
      expect(transferArg.amount).toBe(2340);

      // Pool contribution recorded for the worker's gross share (gross basis)
      expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
        'task-1', 'worker-1', 60,
      );
    });

    it('routes a Service Business partial settlement to the provider payee while insuring the fulfiller', async () => {
      installPartialRefundFixture({
        workerId: 'crew-worker-1',
        payoutRecipientUserId: 'business-payee-1',
        posterId: 'poster-1',
        destinationAccountId: 'acct_business',
      });
      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });

      expect(result.success).toBe(true);
      const connectQuery = mockDb.query.mock.calls.find(([sql]) =>
        String(sql).includes('SELECT payouts_enabled,stripe_connect_id,stripe_connect_status'));
      expect(connectQuery?.[1]).toEqual(['business-payee-1']);
      expect(vi.mocked(MockStripe.createTransfer)).toHaveBeenCalledWith(expect.objectContaining({
        workerId: 'business-payee-1', workerStripeAccountId: 'acct_business', amount: 2340,
      }));
      expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
        'task-1','crew-worker-1',60,
      );
    });

    it('skips Stripe transfer only when the recorded transfer has an exact current provider witness', async () => {
      installPartialRefundFixture({ version: 1, existingTransferId: 'tr_existing' });

      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });
      expect(result.success).toBe(true);

      // createTransfer must NOT have been called (idempotency: already recorded)
      expect(vi.mocked(MockStripe.createTransfer)).not.toHaveBeenCalled();
      // createRefund must still have been called (refund side not yet done)
      expect(vi.mocked(MockStripe.createRefund)).toHaveBeenCalledTimes(1);
    });

    it('skips Stripe refund only when the recorded refund has an exact immutable checkpoint', async () => {
      installPartialRefundFixture({ version: 1, existingRefundId: 're_existing' });

      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });
      expect(result.success).toBe(true);

      // createTransfer must still have been called (transfer side not yet done)
      expect(vi.mocked(MockStripe.createTransfer)).toHaveBeenCalledTimes(1);
      // createRefund must NOT have been called (idempotency: already recorded)
      expect(vi.mocked(MockStripe.createRefund)).not.toHaveBeenCalled();
    });

    it('rejects when percentages do not sum to 100', async () => {
      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 50,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('sum to 100');
    });
  });

  // -------------------------------------------------------------------------
  // State Machine Helpers
  // -------------------------------------------------------------------------
  describe('isTerminalState', () => {
    it('returns true for RELEASED, REFUNDED, REFUND_PARTIAL', () => {
      expect(EscrowService.isTerminalState('RELEASED')).toBe(true);
      expect(EscrowService.isTerminalState('REFUNDED')).toBe(true);
      expect(EscrowService.isTerminalState('REFUND_PARTIAL')).toBe(true);
    });

    it('returns false for PENDING, FUNDED, LOCKED_DISPUTE', () => {
      expect(EscrowService.isTerminalState('PENDING')).toBe(false);
      expect(EscrowService.isTerminalState('FUNDED')).toBe(false);
      expect(EscrowService.isTerminalState('LOCKED_DISPUTE')).toBe(false);
    });
  });

  describe('isValidTransition', () => {
    it('allows valid transitions', () => {
      expect(EscrowService.isValidTransition('PENDING', 'FUNDED')).toBe(true);
      expect(EscrowService.isValidTransition('FUNDED', 'RELEASED')).toBe(true);
      expect(EscrowService.isValidTransition('FUNDED', 'LOCKED_DISPUTE')).toBe(true);
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'RELEASED')).toBe(true);
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'REFUND_PARTIAL')).toBe(true);
    });

    it('blocks invalid transitions', () => {
      expect(EscrowService.isValidTransition('RELEASED', 'FUNDED')).toBe(false);
      expect(EscrowService.isValidTransition('PENDING', 'RELEASED')).toBe(false);
      expect(EscrowService.isValidTransition('PENDING', 'LOCKED_DISPUTE')).toBe(false);
    });
  });

  describe('getValidTransitions', () => {
    it('returns correct transitions for each state', () => {
      expect(EscrowService.getValidTransitions('PENDING')).toEqual(['FUNDED', 'REFUNDED']);
      expect(EscrowService.getValidTransitions('RELEASED')).toEqual([]);
      expect(EscrowService.getValidTransitions('LOCKED_DISPUTE')).toEqual(['RELEASED', 'REFUNDED', 'REFUND_PARTIAL']);
    });
  });

  // -------------------------------------------------------------------------
  // D1 containment: legacy administrative refunds are compatibility-denial only
  // -------------------------------------------------------------------------
  describe('refund — administrative override is disabled before effects', () => {
    it('rejects a RELEASED escrow without reading the database or issuing a refund', async () => {
      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.refund({ escrowId: 'esc-1', adminOverride: true });

      expect(result).toMatchObject({
        success: false,
        error: { code: 'INVALID_STATE' },
      });
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(MockStripe.createRefund)).not.toHaveBeenCalled();
    });

    it('rejects even when a transfer reversal would otherwise be available', async () => {
      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.refund({ escrowId: 'esc-1', adminOverride: true });

      expect(result).toMatchObject({
        success: false,
        error: { code: 'INVALID_STATE' },
      });
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(MockStripe.createTransferReversal)).not.toHaveBeenCalled();
      expect(vi.mocked(MockStripe.createRefund)).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// INV: no XP (and no payout side-effects) without a successfully RELEASED escrow.
// release() only reaches the post-commit side-effects (XP award, insurance
// contribution, earnings unlock) AFTER the version-checked UPDATE actually flips
// the row to RELEASED. If the UPDATE affects 0 rows (already terminal / raced),
// none of those side-effects must fire. The refund path must never award XP.
// ===========================================================================
describe('EscrowService — XP/payout side-effects gated on successful RELEASE', () => {
  it('does NOT award XP / record insurance / record earnings when release UPDATE affects 0 rows (already terminal)', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
    const taskRow = { worker_id: 'worker-1', price: 5000 };
    const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)   // SELECT escrow FOR UPDATE
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)     // SELECT task
      .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)            // UPDATE → 0 rows (terminal/raced)
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED' })], rowCount: 1 } as never); // getById fallback

    const result = await EscrowService.release(stripeReleaseParams('tr_x'));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('HX002'); // ESCROW_TERMINAL
    // No release occurred → no XP, no insurance contribution, no earnings unlock.
    expect(vi.mocked(XPService.awardXP)).not.toHaveBeenCalled();
    expect(vi.mocked(SelfInsurancePoolService.recordContribution)).not.toHaveBeenCalled();
    expect(vi.mocked(EarnedVerificationUnlockService.recordEarnings)).not.toHaveBeenCalled();
  });

  it('does NOT award XP on a successful refund (XP requires RELEASED; refund terminalizes to REFUNDED)', async () => {
    const refunded = makeEscrow({
      state: 'REFUNDED',
      refund_transition_event_exact: true,
      event_key: 'escrow-refunded-transition-v1:esc-1:1',
      event_metadata: {},
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [exactRefundBinding()], rowCount: 1 } as never) // T1 pre-check
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never) // T1 exact unassigned task
      .mockResolvedValueOnce({ rows: [refundProviderClaimRow('esc-1', 0)], rowCount: 1 } as never) // T1 immutable provider-call claim
      .mockResolvedValueOnce({ rows: [{ allowed: true }], rowCount: 1 } as never) // pre-provider claim revalidation
      .mockResolvedValueOnce({ rows: [{ metadata: exactSucceededRefundMetadata() }], rowCount: 1 } as never) // durable exact provider witness
      .mockResolvedValueOnce({ rows: [exactRefundBinding()], rowCount: 1 } as never) // T2 exact FOR UPDATE NOWAIT
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', version: 2, worker_id: null, state: 'OPEN' }], rowCount: 1 } as never) // T2 exact task binding
      .mockResolvedValueOnce({ rows: [{ exact: true }], rowCount: 1 } as never) // T2 immutable claim resolution
      .mockResolvedValueOnce({ rows: [{ set_config: 'esc-1' }], rowCount: 1 } as never) // T2 trigger authority
      .mockResolvedValueOnce({ rows: [refunded], rowCount: 1 } as never); // T2 UPDATE → REFUNDED + transition

    const result = await EscrowService.refund({ escrowId: 'esc-1' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.state).toBe('REFUNDED');
    expect(vi.mocked(XPService.awardXP)).not.toHaveBeenCalled();
  });
});
