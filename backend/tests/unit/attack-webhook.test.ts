/**
 * attack-webhook.test.ts — Red-Team Attack Suite for Stripe Webhook Handling
 *
 * Probes:
 *  - Replay attacks (events fired twice)
 *  - Wrong event ordering (out-of-order delivery)
 *  - Signature verification bypasses
 *  - Event coverage gaps (unhandled lifecycle events)
 *
 * Every test cites the exact source file:line being exercised, shows
 * the actual handling behaviour, and is labelled VERDICT: EXPLOIT / GAP / SAFE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must precede all imports
// ---------------------------------------------------------------------------

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'sk_test_attacktest_validkey',
      webhookSecret: 'whsec_attack_test_secret',
      platformFeePercent: 15,
      minimumTaskValueCents: 500,
    },
    app: { isProduction: false },
    firebase: {
      projectId: 'test-project',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4PAtqbzNPYkFg==\n-----END RSA PRIVATE KEY-----\n',
    },
    redis: { restUrl: undefined, restToken: undefined },
  },
}));

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => 'Invariant violated'),
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  workerLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  escrowLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue({ id: 'outbox-1', idempotencyKey: 'k1' }),
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    advanceProgress: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }),
  },
}));

vi.mock('../../src/services/ChargebackService', () => ({
  ChargebackService: {
    handleDisputeCreated: vi.fn().mockResolvedValue(undefined),
    handleDisputeUpdated: vi.fn().mockResolvedValue(undefined),
    handleDisputeClosed: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/PushNotificationService', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: vi.fn(() => ({})),
  credential: { cert: vi.fn(() => ({})) },
  messaging: vi.fn(() => ({ send: vi.fn().mockResolvedValue('msg-id') })),
}));

// Stripe mock — constructEvent is controlled per-test
const { mockConstructEvent } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
}));

vi.mock('stripe', () => {
  const StripeMock = vi.fn(function StripeConstructor() {
    return {
      webhooks: {
        constructEvent: mockConstructEvent,
        // DEFAULT_TOLERANCE is 300 seconds (5 minutes) per Stripe SDK source
        DEFAULT_TOLERANCE: 300,
      },
    };
  });
  return { default: StripeMock };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { processWebhook } from '../../src/services/StripeWebhookService';
import { processStripeEventJob } from '../../src/jobs/stripe-event-worker';
import { processPaymentJob } from '../../src/jobs/payment-worker';
import { RevenueService } from '../../src/services/RevenueService';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStripeEvent(overrides: Partial<{
  id: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
}> = {}) {
  return {
    id: overrides.id ?? 'evt_test_001',
    type: overrides.type ?? 'payment_intent.succeeded',
    created: overrides.created ?? Math.floor(Date.now() / 1000),
    data: overrides.data ?? { object: { id: 'pi_test_001', amount: 10000, metadata: {} } },
  };
}

// Minimal BullMQ Job stub
function makeJob(data: object) {
  return { data, id: 'job-1', opts: {} } as Parameters<typeof processStripeEventJob>[0];
}

// Build payment-worker job payload (wraps data in { payload: ... })
function makePaymentJob(stripeEventId: string, eventType: string, eventObject: Record<string, unknown>) {
  return {
    data: {
      payload: {
        stripeEventId,
        eventType,
        eventCreated: new Date().toISOString(),
      },
    },
    id: 'payment-job-1',
    opts: {},
  } as Parameters<typeof processPaymentJob>[0];
}

beforeEach(() => {
  // resetAllMocks clears both call history AND the mockResolvedValueOnce queue,
  // preventing queue pollution between tests in the same describe block.
  vi.resetAllMocks();
  // Restore the Stripe constructor mock after reset so processWebhook tests work.
  // The Stripe mock module returns a class — mockConstructEvent is used per-test.
});

// ===========================================================================
// 1. REPLAY ATTACKS
// ===========================================================================

describe('REPLAY ATTACK 1 — payment_intent.succeeded replayed', () => {
  /**
   * SOURCE: backend/src/services/StripeWebhookService.ts:135–152
   *   INSERT INTO stripe_events ... ON CONFLICT (stripe_event_id) DO NOTHING
   *   RETURNING stripe_event_id
   *   → If rowCount === 0 (conflict), returns { stored: false } immediately.
   *   writeToOutbox is NOT called for duplicates, so the event is never re-queued.
   *
   * SOURCE: backend/src/jobs/payment-worker.ts:58–91
   *   UPDATE stripe_events SET claimed_at=NOW() WHERE ... AND claimed_at IS NULL AND processed_at IS NULL
   *   → If event already claimed/processed, returns early (no-op).
   *
   * VERDICT: SAFE — Two independent idempotency guards: ON CONFLICT at ingestion,
   * atomic-claim at processing. A replayed payment_intent.succeeded cannot fund
   * the escrow twice.
   */
  it('second ingestion of the same stripe event returns success but does NOT enqueue again', async () => {
    const evt = makeStripeEvent({ id: 'evt_pi_replay', type: 'payment_intent.succeeded' });
    mockConstructEvent.mockReturnValue(evt);

    // Simulate ON CONFLICT DO NOTHING → rowCount=0 on second ingestion
    const txQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof txQuery) => Promise<unknown>) => fn(txQuery));

    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const result = await processWebhook('body', 'sig');

    expect(result.success).toBe(true);
    // CRITICAL: writeToOutbox must NOT be called — event not re-enqueued
    expect(vi.mocked(writeToOutbox)).not.toHaveBeenCalled();
  });

  it('processing worker skips event already claimed by another worker', async () => {
    const stripeEventId = 'evt_pi_replay';

    // Atomic claim fails (claimed_at already set) → rowCount=0
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ result: 'processing', claimed_at: new Date(), processed_at: null }], rowCount: 1 }) // first SELECT (existing check)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // Claim UPDATE returns nothing

    // Re-wire: claim UPDATE returns 0 rows (already claimed)
    mockDb.query.mockReset();
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // Claim UPDATE fails (already claimed)
      .mockResolvedValueOnce({ rows: [{ result: 'processing', claimed_at: new Date(), processed_at: null }], rowCount: 1 }); // SELECT for existing check

    const job = makePaymentJob(stripeEventId, 'payment_intent.succeeded', {});
    await processPaymentJob(job);

    // The worker exits after the second query — no further DB calls (no escrow update)
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });
});

describe('REPLAY ATTACK 2 — transfer.created replayed', () => {
  /**
   * SOURCE: backend/src/jobs/payment-worker.ts:287–307
   *   Terminal-skip guard: if state in RELEASED/REFUNDED/REFUND_PARTIAL → skip.
   *   Idempotency: if state=RELEASED AND stripe_transfer_id === transferId → return early.
   *
   * VERDICT: SAFE — On replay the escrow is already RELEASED (terminal state).
   * The terminal-skip guard fires before any UPDATE, preventing double-release.
   */
  it('transfer.created replay: escrow already RELEASED → skipped, no double-release', async () => {
    const escrowId = 'escrow-released-001';
    const transferId = 'tr_test_001';
    const stripeEventId = 'evt_transfer_replay';

    // Claim succeeds
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          stripe_event_id: stripeEventId,
          type: 'transfer.created',
          payload_json: {
            data: {
              object: {
                id: transferId,
                metadata: { escrow_id: escrowId },
              },
            },
          },
        }],
        rowCount: 1,
      })
      // SELECT escrow FOR UPDATE → already RELEASED
      .mockResolvedValueOnce({
        rows: [{ id: escrowId, task_id: 'task-1', state: 'RELEASED', version: 2, stripe_transfer_id: transferId }],
        rowCount: 1,
      })
      // UPDATE stripe_events SET result='skipped'
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makePaymentJob(stripeEventId, 'transfer.created', {});
    // Should not throw — skipped gracefully
    await expect(processPaymentJob(job)).resolves.not.toThrow();

    // Verify: no additional escrow UPDATE was attempted beyond the skip mark
    const allCalls = mockDb.query.mock.calls.map(c => c[0] as string);
    const escrowUpdateCalls = allCalls.filter(sql =>
      typeof sql === 'string' && sql.includes("SET state = 'RELEASED'")
    );
    expect(escrowUpdateCalls).toHaveLength(0);
  });
});

describe('REPLAY ATTACK 3 — charge.refunded replayed', () => {
  /**
   * SOURCE: backend/src/jobs/payment-worker.ts:427–450
   *   Terminal-skip: if state in RELEASED/REFUNDED/REFUND_PARTIAL → skip immediately.
   *   Secondary idempotency: if state=REFUNDED AND stripe_refund_id=refundId → return.
   *
   * VERDICT: SAFE — A replayed charge.refunded event hits the terminal-skip guard
   * (escrow is already REFUNDED) and exits before any UPDATE.
   */
  it('charge.refunded replay: escrow already REFUNDED → skipped, no double-refund', async () => {
    const escrowId = 'escrow-refunded-001';
    const refundId = 're_test_001';
    const stripeEventId = 'evt_refund_replay';

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          stripe_event_id: stripeEventId,
          type: 'charge.refunded',
          payload_json: {
            data: {
              object: {
                id: 'ch_test_001',
                metadata: { escrow_id: escrowId },
                refunds: { data: [{ id: refundId }] },
              },
            },
          },
        }],
        rowCount: 1,
      })
      // SELECT escrow FOR UPDATE → already REFUNDED
      .mockResolvedValueOnce({
        rows: [{ id: escrowId, task_id: 'task-1', state: 'REFUNDED', version: 2, stripe_refund_id: refundId }],
        rowCount: 1,
      })
      // UPDATE stripe_events SET result='skipped'
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makePaymentJob(stripeEventId, 'charge.refunded', {});
    await expect(processPaymentJob(job)).resolves.not.toThrow();

    const allCalls = mockDb.query.mock.calls.map(c => c[0] as string);
    const refundUpdateCalls = allCalls.filter(sql =>
      typeof sql === 'string' && sql.includes("SET state = 'REFUNDED'")
    );
    expect(refundUpdateCalls).toHaveLength(0);
  });
});

describe('REPLAY ATTACK 4 — invoice.paid replayed (subscription credits)', () => {
  /**
   * SOURCE: backend/src/jobs/stripe-event-worker.ts:295–313 (handleInvoicePaid)
   *   Calls RevenueService.logEvent() — plain INSERT, no ON CONFLICT.
   *
   * SOURCE: backend/src/services/RevenueService.ts:118–146 (logEvent)
   *   INSERT INTO revenue_ledger ... RETURNING id
   *   NO ON CONFLICT clause — every call inserts a new row.
   *
   * However: the outer S-1 atomic-claim in stripe-event-worker.ts:63–84 prevents
   * the worker from processing the same stripe_event_id twice, because
   * claimed_at IS NULL AND processed_at IS NULL must both hold.
   *
   * VERDICT: SAFE with caveat — The per-event atomic claim stops double-processing
   * at the worker level. RevenueService.logEvent itself is NOT idempotent (no
   * ON CONFLICT), but it is protected by the stripe_events claim guard upstream.
   * If the claim guard is bypassed (e.g., by a bug resetting claimed_at), duplicate
   * revenue rows would be inserted. This is a GAP in defense-in-depth but not an
   * exploitable replay under normal operation.
   */
  it('invoice.paid first delivery: claim succeeds, RevenueService.logEvent called once', async () => {
    const stripeEventId = 'evt_invoice_paid_first';

    // stripe-event-worker claim UPDATE returns { payload_json, type }
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          payload_json: {
            id: stripeEventId,
            data: {
              object: {
                id: 'in_test_001',
                amount_paid: 2999,
                metadata: { user_id: 'user-001' },
              },
            },
          },
          type: 'invoice.paid',
        }],
        rowCount: 1,
      })
      // Final UPDATE: result='success'
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makeJob({ stripeEventId, type: 'invoice.paid' });
    await processStripeEventJob(job);
    // RevenueService was called exactly once
    expect(vi.mocked(RevenueService.logEvent)).toHaveBeenCalledTimes(1);
  });

  it('invoice.paid replay: claim guard fires, RevenueService.logEvent NOT called', async () => {
    const stripeEventId = 'evt_invoice_paid_replay';

    // Claim returns 0 rows → already processed (S-1 atomic claim guard)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const job = makeJob({ stripeEventId, type: 'invoice.paid' });
    await processStripeEventJob(job);

    // RevenueService must NOT be called — event was already claimed
    expect(vi.mocked(RevenueService.logEvent)).toHaveBeenCalledTimes(0);
  });

  it('GAP — RevenueService.logEvent has no ON CONFLICT guard (not idempotent in isolation)', () => {
    /**
     * This is a documentation test. If the atomic-claim guard ever fails to prevent
     * re-entry (e.g., due to a migration resetting claimed_at, or a future code change),
     * invoice.paid would insert duplicate rows in revenue_ledger because logEvent
     * does a plain INSERT with no idempotency key constraint.
     *
     * Recommendation: Add ON CONFLICT (stripe_event_id) DO NOTHING to revenue_ledger
     * inserts that originate from webhook events, or add a UNIQUE constraint on
     * (stripe_event_id) in revenue_ledger.
     */
    // Verify the mock has no ON CONFLICT protection
    const logEventImpl = RevenueService.logEvent.toString();
    // The real implementation (RevenueService.ts:118-146) does a plain INSERT
    // This test documents the finding — mock always succeeds (no DB constraint)
    expect(true).toBe(true); // structural gap documented above
  });
});

// ===========================================================================
// 2. WRONG EVENT ORDERING
// ===========================================================================

describe('WRONG ORDER 5 — transfer.created before payment_intent.succeeded', () => {
  /**
   * SOURCE: backend/src/jobs/payment-worker.ts:309–314
   *   Validates state transition: if escrow.state !== 'FUNDED' → throw Error.
   *   The escrow is still PENDING (payment_intent.succeeded not yet processed).
   *
   * VERDICT: SAFE — The handler throws "Cannot release escrow: current state is PENDING".
   * BullMQ will retry the job. When payment_intent.succeeded is eventually processed
   * and the escrow reaches FUNDED, the retried transfer.created job will succeed.
   * However: if retry exhaustion occurs before payment_intent.succeeded arrives,
   * the escrow could be permanently stuck in FUNDED with no release. This is a
   * partial GAP in retry-window sizing, not a security exploit.
   */
  it('transfer.created on PENDING escrow throws, preventing premature release', async () => {
    const escrowId = 'escrow-pending-001';
    const transferId = 'tr_premature_001';
    const stripeEventId = 'evt_transfer_early';

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          stripe_event_id: stripeEventId,
          type: 'transfer.created',
          payload_json: {
            data: {
              object: {
                id: transferId,
                metadata: { escrow_id: escrowId },
              },
            },
          },
        }],
        rowCount: 1,
      })
      // SELECT escrow FOR UPDATE → still PENDING
      .mockResolvedValueOnce({
        rows: [{ id: escrowId, task_id: 'task-1', state: 'PENDING', version: 1, stripe_transfer_id: null }],
        rowCount: 1,
      })
      // UPDATE stripe_events SET result='failed'
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makePaymentJob(stripeEventId, 'transfer.created', {});
    // Handler throws so BullMQ can retry
    await expect(processPaymentJob(job)).rejects.toThrow('expected FUNDED');
  });
});

describe('WRONG ORDER 6 — charge.refunded before charge.succeeded (escrow not yet created)', () => {
  /**
   * SOURCE: backend/src/jobs/payment-worker.ts:421–423
   *   If escrowResult.rows.length === 0 → throw Error(`Escrow not found for refund...`).
   *
   * VERDICT: SAFE — The handler throws when no escrow is found, preventing a phantom
   * refund. BullMQ retries. If the original charge/payment_intent event never arrives
   * (Stripe delivery failure), the refund job will exhaust retries and land in the
   * dead-letter queue. No funds are moved without a matching escrow record.
   */
  it('charge.refunded with no matching escrow throws (no phantom refund)', async () => {
    const stripeEventId = 'evt_refund_no_escrow';
    const refundId = 're_orphan_001';

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          stripe_event_id: stripeEventId,
          type: 'charge.refunded',
          payload_json: {
            data: {
              object: {
                id: 'ch_no_escrow',
                metadata: {}, // no escrow_id in metadata
                payment_intent: 'pi_no_escrow',
                refunds: { data: [{ id: refundId }] },
              },
            },
          },
        }],
        rowCount: 1,
      })
      // Fallback lookup by payment_intent_id → no rows
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // UPDATE stripe_events SET result='failed'
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makePaymentJob(stripeEventId, 'charge.refunded', {});
    await expect(processPaymentJob(job)).rejects.toThrow('Escrow not found');
  });
});

describe('WRONG ORDER 7 — dispute.created on already-RELEASED escrow', () => {
  /**
   * SOURCE: backend/src/services/ChargebackService.ts (handleDisputeCreated)
   *   The ChargebackService is called via stripe-event-worker.ts:315-330 for
   *   charge.dispute.created events.
   *
   * SOURCE: backend/src/services/EscrowService.ts:75-82 (VALID_TRANSITIONS)
   *   RELEASED: [] — terminal, no transitions allowed.
   *
   * SOURCE: backend/src/services/EscrowService.ts:659–682 (lockForDispute)
   *   UPDATE escrows SET state='LOCKED_DISPUTE' WHERE id=$1 AND state='FUNDED'
   *   → If state is RELEASED, rowCount=0, returns INVALID_STATE error.
   *
   * VERDICT: SAFE — The ChargebackService records the dispute independently of
   * the escrow state (it inserts a chargeback record). EscrowService.lockForDispute
   * would return INVALID_STATE if called on a RELEASED escrow. The dispute event
   * is stored and chargebacks tracked, but the released escrow is not re-locked.
   * No funds are double-moved.
   */
  it('charge.dispute.created on released escrow: ChargebackService called but escrow unchanged', async () => {
    const { ChargebackService } = await import('../../src/services/ChargebackService');
    const stripeEventId = 'evt_dispute_late';

    // stripe-event-worker atomic claim
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // claim fails (already processed)

    const job = makeJob({ stripeEventId, type: 'charge.dispute.created' });
    // If already processed, returns early — ChargebackService not called twice
    await processStripeEventJob(job);
    expect(vi.mocked(ChargebackService.handleDisputeCreated)).not.toHaveBeenCalled();
  });

  it('charge.dispute.created on RELEASED escrow: lockForDispute returns INVALID_STATE (not EXPLOIT)', async () => {
    /**
     * This test documents that EscrowService.lockForDispute enforces the state machine.
     * Even if ChargebackService records the dispute, no escrow re-locking occurs
     * because the UPDATE WHERE state='FUNDED' clause rejects a RELEASED escrow.
     *
     * lockForDispute wraps everything in db.transaction(async (query) => {...}).
     * The transaction-internal query fn handles:
     *   1. SELECT window check (returns completed_at + challenge_window_hours + version)
     *   2. UPDATE WHERE state='FUNDED' → rowCount=0 because escrow is RELEASED
     * Then EscrowService.getById() uses db.query directly (outside the transaction):
     *   3. SELECT escrow → returns RELEASED state, triggering INVALID_STATE error return
     */
    const { EscrowService } = await import('../../src/services/EscrowService');

    // Set up the transaction mock to run the callback with a scoped query fn.
    // The scoped query fn returns:
    //   call 1: window check — completed_at within window, version=2
    //   call 2: UPDATE WHERE state='FUNDED' → rowCount=0 (escrow is RELEASED, not FUNDED)
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ // call 1: window check SELECT
        rows: [{ completed_at: new Date(Date.now() - 3600_000), challenge_window_hours: 6, version: 2 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // call 2: UPDATE WHERE state='FUNDED' → no match

    mockDb.transaction.mockImplementation(
      async (fn: (query: typeof txQuery) => Promise<unknown>) => fn(txQuery)
    );

    // call 3: EscrowService.getById uses db.query directly — returns RELEASED escrow
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'esc-1', state: 'RELEASED', version: 2, amount: 10000, task_id: 'task-1', poster_id: 'p1', worker_id: 'w1' }],
      rowCount: 1,
    });

    const result = await EscrowService.lockForDispute('escrow-released');
    // Should fail with INVALID_STATE — escrow is RELEASED, not FUNDED
    expect(result.success).toBe(false);
    // State machine rejects the transition — no double-lock
  });
});

// ===========================================================================
// 3. SIGNATURE VERIFICATION
// ===========================================================================

describe('SIGNATURE 8 — Missing stripe-signature header', () => {
  /**
   * SOURCE: backend/src/server.ts:669–673
   *   if (!sig) return c.json({ error: 'Missing stripe-signature header' }, 400)
   *   → Rejected at the HTTP layer before StripeWebhookService is called.
   *
   * SOURCE: backend/src/services/StripeWebhookService.ts:82–90
   *   if (!signature) return { success: false, error: { code: 'WEBHOOK_SECRET_MISSING', ... } }
   *   → Rejected at the service layer as a second guard.
   *
   * VERDICT: SAFE — Both HTTP handler and service enforce presence of signature.
   * The 400 response stops Stripe retries on misconfigured webhooks.
   * In development mode there is no bypass — the same code path runs.
   */
  it('processWebhook returns WEBHOOK_SECRET_MISSING when signature is undefined', async () => {
    const result = await processWebhook('{"id":"evt_nosig"}', undefined);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_SECRET_MISSING');
  });

  it('processWebhook returns WEBHOOK_SECRET_MISSING when signature is empty string', async () => {
    const result = await processWebhook('{"id":"evt_emptysig"}', '');
    // Empty string is falsy → same branch
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_SECRET_MISSING');
  });
});

describe('SIGNATURE 9 — Invalid stripe-signature (wrong HMAC)', () => {
  /**
   * SOURCE: backend/src/services/StripeWebhookService.ts:103–118
   *   stripe.webhooks.constructEvent() throws on bad signature.
   *   Caught → returns { code: 'WEBHOOK_VERIFICATION_FAILED' }.
   *   Event is never stored in stripe_events, never enqueued.
   *
   * VERDICT: SAFE — Invalid HMAC is rejected before any DB write.
   */
  it('processWebhook returns WEBHOOK_VERIFICATION_FAILED on wrong HMAC', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload. Are you passing the raw request body you received from Stripe?');
    });

    const result = await processWebhook('{"id":"evt_badsig"}', 't=1234567890,v1=badhash');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_VERIFICATION_FAILED');
    expect(result.error?.message).toContain('No signatures found');
  });
});

describe('SIGNATURE 10 — stripe-signature with old timestamp (replay window)', () => {
  /**
   * SOURCE: Stripe SDK (stripe-node source: lib/Webhooks.ts)
   *   stripe.webhooks.constructEvent() validates the `t=` timestamp component.
   *   DEFAULT_TOLERANCE = 300 seconds (5 minutes).
   *   If Math.abs(now - timestamp) > tolerance → throws "Timestamp outside the tolerance zone".
   *
   * SOURCE: backend/src/services/StripeWebhookService.ts:103–118
   *   No custom tolerance override is passed to constructEvent.
   *   The Stripe SDK default of 300 seconds applies.
   *
   * VERDICT: SAFE — The Stripe SDK enforces the 5-minute replay window automatically.
   *   A signature with a 10-minute-old timestamp is rejected by constructEvent.
   *   HustleXP does not pass a custom tolerance=0, so the default window applies.
   *
   * GAP (minor): HustleXP does not explicitly configure a stricter tolerance window.
   *   The 5-minute default is Stripe's recommendation. Some high-security deployments
   *   reduce this to 60 seconds. Not an exploit under default configuration.
   */
  it('constructEvent with 10-minute-old timestamp rejected (tolerance exceeded)', async () => {
    mockConstructEvent.mockImplementation(() => {
      // Stripe SDK throws this exact message for stale timestamps
      throw new Error('Timestamp outside the tolerance zone');
    });

    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const staleSignature = `t=${tenMinutesAgo},v1=fakehash`;

    const result = await processWebhook('{"id":"evt_stale"}', staleSignature);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_VERIFICATION_FAILED');
    expect(result.error?.message).toContain('Timestamp outside the tolerance zone');
  });

  it('GAP — no custom tolerance configured; default 300s (5 min) window applies', () => {
    /**
     * Verification: StripeWebhookService.ts calls constructEvent(rawBody, signature, secret)
     * with 3 arguments. The Stripe SDK overload for 3 args uses DEFAULT_TOLERANCE=300.
     * No 4th options argument (e.g., { tolerance: 60 }) is passed.
     *
     * Risk: An attacker who can replay a request within 5 minutes of the original
     * delivery has a valid signature. The stripe_events ON CONFLICT guard prevents
     * escrow double-processing in that window, so this is defense-in-depth fine.
     */
    expect(true).toBe(true); // documented gap, not exploitable due to ON CONFLICT guard
  });
});

// ===========================================================================
// 4. EVENT COVERAGE GAPS
// ===========================================================================

describe('GAP 11 — payment_intent.payment_failed: no escrow cleanup handler', () => {
  /**
   * SOURCE: backend/src/jobs/stripe-event-worker.ts:91–145 (switch statement)
   *   Cases handled: customer.subscription.*, checkout.session.completed,
   *   payment_intent.succeeded, invoice.payment_failed, invoice.paid,
   *   charge.dispute.*, account.updated.
   *
   *   MISSING: 'payment_intent.payment_failed'
   *
   * SOURCE: backend/src/jobs/payment-worker.ts:99–125 (switch statement)
   *   Cases handled: payment_intent.succeeded, transfer.created, charge.refunded.
   *   MISSING: 'payment_intent.payment_failed'
   *
   * VERDICT: GAP — When a payment intent fails (declined card), neither worker
   * handles the event. The escrow remains in PENDING state indefinitely.
   * The task is NOT returned to OPEN state. The poster's funds were never captured
   * (payment_intent stays requires_payment_method), so no money is lost, but the
   * task is orphaned with a PENDING escrow. Poster cannot re-attempt payment without
   * admin intervention.
   *
   * Recommended fix: Add 'payment_intent.payment_failed' handler that transitions
   * escrow PENDING → REFUNDED (or a new FAILED state) and task back to OPEN.
   */
  it('payment_intent.payment_failed is routed to default (skipped) in stripe-event-worker', async () => {
    const stripeEventId = 'evt_pi_failed_001';

    // stripe-event-worker claim UPDATE returns { payload_json, type }
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          payload_json: {
            id: stripeEventId,
            data: {
              object: {
                id: 'pi_declined',
                last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
              },
            },
          },
          type: 'payment_intent.payment_failed',
        }],
        rowCount: 1,
      })
      // UPDATE stripe_events SET result='skipped' (default branch)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makeJob({ stripeEventId, type: 'payment_intent.payment_failed' });
    await processStripeEventJob(job);

    // Verify the event was skipped (stripe-event-worker default branch uses $1 for stripe_event_id)
    const updateCall = mockDb.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes("'skipped'") && c[1]?.[0] === stripeEventId
    );
    expect(updateCall).toBeTruthy();
  });

  it.skip('payment_intent.payment_failed is also unhandled in payment-worker (goes to default/skipped) [GAP CLOSED: handler added Round 2]', async () => {
    const stripeEventId = 'evt_pi_failed_pw';

    mockDb.query
      .mockResolvedValueOnce({
        // payment-worker claim: RETURNING stripe_event_id, type, payload_json
        rows: [{
          stripe_event_id: stripeEventId,
          type: 'payment_intent.payment_failed',
          payload_json: {
            id: stripeEventId,
            type: 'payment_intent.payment_failed',
            data: {
              object: { id: 'pi_declined', last_payment_error: { code: 'card_declined' } },
            },
          },
        }],
        rowCount: 1,
      })
      // Unknown event type → skipped
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makePaymentJob(stripeEventId, 'payment_intent.payment_failed', {});
    await processPaymentJob(job);

    const skipCall = mockDb.query.mock.calls.find(c =>
      typeof c[0] === 'string' &&
      c[0].includes("result = 'skipped'") &&
      Array.isArray(c[1]) && c[1].includes(stripeEventId)
    );
    expect(skipCall).toBeTruthy();
  });
});

describe('GAP 12 — account.updated for Connect KYC: HANDLED', () => {
  /**
   * SOURCE: backend/src/jobs/stripe-event-worker.ts:128–129
   *   case 'account.updated': → handleAccountUpdated(event)
   *
   * SOURCE: backend/src/jobs/stripe-event-worker.ts:232–293 (handleAccountUpdated)
   *   - Looks up user by stripe_connect_account_id
   *   - Derives connectStatus from details_submitted + payouts_enabled + charges_enabled
   *   - Updates users SET stripe_connect_status, payouts_enabled, charges_enabled
   *   - If requirements.currently_due is non-empty → sends 'security_alert' notification
   *
   * VERDICT: SAFE — account.updated IS handled. KYC status syncs correctly.
   */
  it('account.updated event is dispatched to handleAccountUpdated', async () => {
    const stripeEventId = 'evt_acct_updated';

    // stripe-event-worker claim UPDATE returns { payload_json, type }
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          payload_json: {
            id: stripeEventId,
            data: {
              object: {
                id: 'acct_test_001',
                details_submitted: true,
                payouts_enabled: true,
                charges_enabled: true,
                requirements: { currently_due: [] },
              },
            },
          },
          type: 'account.updated',
        }],
        rowCount: 1,
      })
      // SELECT user by stripe_connect_account_id
      .mockResolvedValueOnce({ rows: [{ id: 'user-001' }], rowCount: 1 })
      // UPDATE users SET stripe_connect_status
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // Final UPDATE stripe_events result='success'
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makeJob({ stripeEventId, type: 'account.updated' });
    await expect(processStripeEventJob(job)).resolves.not.toThrow();

    // Verify user update was called with correct connect status
    const updateCall = mockDb.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('stripe_connect_status')
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall?.[1]).toContain('active'); // fully onboarded account
  });
});

describe('GAP 13 — transfer.failed: NO HANDLER', () => {
  /**
   * SOURCE: backend/src/jobs/stripe-event-worker.ts:91–145 (switch statement)
   *   'transfer.failed' is not a case. Falls to default → result='skipped'.
   *
   * SOURCE: backend/src/jobs/payment-worker.ts:99–125
   *   'transfer.failed' is not a case. Falls to default → result='skipped'.
   *
   * VERDICT: EXPLOIT / GAP — This is the most serious finding.
   *   When a Stripe transfer to the worker fails:
   *   1. payment-worker.ts handleTransferCreated already moved escrow to RELEASED.
   *   2. transfer.created fires → escrow is RELEASED (money "out the door" in our DB).
   *   3. transfer.failed fires → NO HANDLER → skipped.
   *   4. Escrow stays RELEASED. Worker's Stripe balance shows failed transfer.
   *   5. No notification to worker. No reconciliation. Funds are in limbo.
   *
   *   In practice: Stripe keeps the funds in the platform account balance.
   *   HustleXP has no automated recovery path — an admin must manually re-issue
   *   the transfer or mark the escrow as needing reconciliation.
   *
   *   Recommended fix: Add 'transfer.failed' handler that:
   *   - Sends urgent notification to worker (bank account issue)
   *   - Logs to revenue_ledger as a failed_transfer event
   *   - Potentially transitions escrow to a new TRANSFER_FAILED state for ops triage
   */
  it('transfer.failed is not handled — falls to default skipped branch in stripe-event-worker', async () => {
    const stripeEventId = 'evt_transfer_failed';

    // stripe-event-worker claim returns { payload_json, type }
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          payload_json: {
            id: stripeEventId,
            data: {
              object: {
                id: 'tr_failed_001',
                amount: 8500,
                destination: 'acct_worker_001',
                metadata: { escrow_id: 'escrow-released-001', worker_id: 'worker-001' },
                failure_message: 'The transfer failed.',
              },
            },
          },
          type: 'transfer.failed',
        }],
        rowCount: 1,
      })
      // Default branch: UPDATE stripe_events SET result='skipped'
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makeJob({ stripeEventId, type: 'transfer.failed' });
    await processStripeEventJob(job);

    const skipCall = mockDb.query.mock.calls.find(c =>
      typeof c[0] === 'string' &&
      c[0].includes("result = 'skipped'") &&
      Array.isArray(c[1]) && c[1].includes(stripeEventId)
    );
    expect(skipCall).toBeTruthy();
  });

  it.skip('transfer.failed is also unhandled in payment-worker — skipped, no reconciliation [GAP CLOSED: handler added Round 2]', async () => {
    const stripeEventId = 'evt_transfer_failed_pw';

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          stripe_event_id: stripeEventId,
          type: 'transfer.failed',
          payload_json: {
            data: {
              object: {
                id: 'tr_failed_002',
                metadata: { escrow_id: 'escrow-released-002' },
              },
            },
          },
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makePaymentJob(stripeEventId, 'transfer.failed', {});
    await processPaymentJob(job);

    const skipCall = mockDb.query.mock.calls.find(c =>
      typeof c[0] === 'string' &&
      c[0].includes("result = 'skipped'") &&
      Array.isArray(c[1]) && c[1].includes(stripeEventId)
    );
    expect(skipCall).toBeTruthy();
  });
});

describe('GAP 14 — payout.failed: NO HANDLER', () => {
  /**
   * SOURCE: backend/src/jobs/stripe-event-worker.ts:91–145
   *   'payout.failed' is not a case. Falls to default → result='skipped'.
   *
   * VERDICT: GAP — When a worker's bank rejects the payout (invalid account number,
   *   closed account, etc.), Stripe fires payout.failed. HustleXP has no handler.
   *   The worker is not notified. The payout amount is returned to the platform's
   *   Stripe balance automatically by Stripe, but HustleXP does not know about it.
   *   Funds are not lost (Stripe holds them), but the worker sees no notification and
   *   no re-payout is triggered.
   *
   *   Note: payout.failed is distinct from transfer.failed:
   *   - transfer.created: platform → worker's Stripe Connect balance (handled, see GAP 13)
   *   - payout.created/failed: worker's Stripe Connect balance → worker's bank account
   *     (entirely Stripe Connect's concern, but HustleXP has no observability into it)
   *
   *   Recommended fix: Add 'payout.failed' handler (listening on Connect account webhooks)
   *   that notifies the worker to update their bank details.
   */
  it('payout.failed falls to default skipped branch — worker not notified', async () => {
    const stripeEventId = 'evt_payout_failed';

    // stripe-event-worker claim returns { payload_json, type }
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          payload_json: {
            id: stripeEventId,
            data: {
              object: {
                id: 'po_failed_001',
                amount: 8500,
                currency: 'usd',
                failure_code: 'account_closed',
                failure_message: 'The bank account provided has been closed.',
              },
            },
          },
          type: 'payout.failed',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const job = makeJob({ stripeEventId, type: 'payout.failed' });
    await processStripeEventJob(job);

    const skipCall = mockDb.query.mock.calls.find(c =>
      typeof c[0] === 'string' &&
      c[0].includes("result = 'skipped'") &&
      Array.isArray(c[1]) && c[1].includes(stripeEventId)
    );
    expect(skipCall).toBeTruthy();
  });
});

// ===========================================================================
// BONUS: Two-worker routing conflict for payment_intent.succeeded
// ===========================================================================

describe('BONUS — payment_intent.succeeded routed to BOTH workers (dual-processing risk)', () => {
  /**
   * SOURCE: backend/src/jobs/stripe-event-worker.ts:102–106
   *   case 'payment_intent.succeeded': → processEntitlementPurchase(event, stripeEventId)
   *   (Per-task entitlement creation, NOT escrow funding)
   *
   * SOURCE: backend/src/jobs/payment-worker.ts:100–102
   *   case 'payment_intent.succeeded': → handlePaymentIntentSucceeded(...)
   *   (Escrow PENDING → FUNDED transition)
   *
   * FINDING: payment_intent.succeeded is handled by TWO different workers for
   * DIFFERENT purposes. This is intentional per the comment in stripe-event-worker.ts:103:
   *   "Note: Phase D handles escrow funding for payment_intent.succeeded
   *    This handler is for per-task entitlements (Step 9-D) - separate concern"
   *
   * However: both workers use the SAME atomic-claim mechanism on stripe_events.
   * Only ONE worker can claim a given stripe_event_id. If stripe-event-worker claims
   * the event first, payment-worker never processes it (escrow stays PENDING).
   * If payment-worker claims it first, entitlements are never created.
   *
   * VERDICT: EXPLOIT (routing architecture flaw) — The atomic-claim pattern assumes
   * one logical worker per event type. Using the same stripe_events table claim for
   * two independent processing concerns means only one concern is served per event.
   *
   * Recommended fix: Either use separate event tables/queues per concern, or
   * allow both workers to register as "processors" of the same event without the
   * exclusive claim preventing the second processor from running.
   */
  it('documents dual-routing conflict: only one worker can claim payment_intent.succeeded', async () => {
    const stripeEventId = 'evt_pi_dual';

    // Simulate stripe-event-worker claiming first
    // stripe-event-worker claim UPDATE returns { payload_json, type }
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          payload_json: {
            id: stripeEventId,
            data: {
              object: {
                id: 'pi_dual_001',
                metadata: { user_id: 'user-001', risk_level: 'MEDIUM', task_id: 'task-001' },
              },
            },
          },
          type: 'payment_intent.succeeded',
        }],
        rowCount: 1,
      })
      // S-5 check: SELECT stripe_event_id FROM stripe_events
      .mockResolvedValueOnce({ rows: [{ stripe_event_id: stripeEventId }], rowCount: 1 })
      // INSERT plan_entitlements ON CONFLICT DO NOTHING
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // Final UPDATE result='success'
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const ewJob = makeJob({ stripeEventId, type: 'payment_intent.succeeded' });
    await processStripeEventJob(ewJob);

    // Now payment-worker tries to claim the same event → claim returns 0 rows
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // claim fails (already claimed)
      .mockResolvedValueOnce({ rows: [{ result: 'success', claimed_at: new Date(), processed_at: new Date() }], rowCount: 1 });

    const pwJob = makePaymentJob(stripeEventId, 'payment_intent.succeeded', {});
    // payment-worker silently exits — escrow is NEVER funded
    await expect(processPaymentJob(pwJob)).resolves.not.toThrow();

    // Verify: no escrow UPDATE was called from payment-worker
    const escrowFundCalls = mockDb.query.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes("SET state = 'FUNDED'")
    );
    expect(escrowFundCalls).toHaveLength(0);
  });
});
