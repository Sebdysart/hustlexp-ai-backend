import { v4 as uuidv4 } from 'uuid';
/**
 * GLOBAL SINGLETON STATE
 * Persists for the entire test run, explicitly reset via FakeStripe.reset()
 */
class FakeStripeState {
    balances = new Map(); // accountId → cents
    transfers = new Map(); // transferId → Transfer
    idempotencyKeys = new Map(); // idempotencyKey → transferId
    events = []; // for assertions
    // Failure simulation
    nextFailure = null;
    reset() {
        this.balances.clear();
        this.transfers.clear();
        this.idempotencyKeys.clear();
        this.events = [];
        this.nextFailure = null;
    }
}
const GLOBAL_STATE = new FakeStripeState();
export class FakeStripe {
    // Expose state for assertions
    static state = GLOBAL_STATE;
    static reset() {
        GLOBAL_STATE.reset();
    }
    static failNext(type, count = 1) {
        GLOBAL_STATE.nextFailure = { type, count };
    }
    transfers = {
        create: async (params, opts) => {
            const idempotencyKey = opts?.idempotencyKey;
            // 1. FAIL HARD - Idempotency Key Required
            if (!idempotencyKey) {
                throw new Error("Stripe Fake: missing idempotency key - STRICT MODE violation");
            }
            // 2. FAIL HARD - Validation
            if (!Number.isInteger(params.amount)) {
                throw new Error(`Stripe Fake: amount must be integer cents, got ${params.amount}`);
            }
            if (params.amount <= 0) {
                throw new Error(`Stripe Fake: amount must be positive, got ${params.amount}`);
            }
            if (!params.destination) {
                throw new Error("Stripe Fake: destination account required");
            }
            if (params.currency !== 'usd') {
                throw new Error(`Stripe Fake: currency must be 'usd', got ${params.currency}`);
            }
            // 3. CHECK FAILURE SIMULATION
            if (GLOBAL_STATE.nextFailure && GLOBAL_STATE.nextFailure.count > 0) {
                const failure = GLOBAL_STATE.nextFailure;
                failure.count--;
                const errorMsg = failure.type === 'timeout'
                    ? 'StripeConnectionError: Connection to Stripe timed out'
                    : 'StripeAPIError: Something went wrong at Stripe';
                GLOBAL_STATE.events.push({
                    type: 'transfer.failed',
                    error: errorMsg,
                    timestamp: Date.now(),
                    idempotencyKey
                });
                // PARTIAL FAILURE SIMULATION (Advanced)
                // If it's a timeout, effectively the request MIGHT have succeeded on server
                // but we simulate client-side failure only. 
                // For 'api_error', it's a hard rejection.
                throw new Error(errorMsg);
            }
            // 4. IDEMPOTENCY CHECK (ATOMIC)
            if (GLOBAL_STATE.idempotencyKeys.has(idempotencyKey)) {
                const existingId = GLOBAL_STATE.idempotencyKeys.get(idempotencyKey);
                const existingTransfer = GLOBAL_STATE.transfers.get(existingId);
                if (!existingTransfer) {
                    // Should never happen if state is consistent
                    throw new Error("Stripe Fake: integrity error - idempotency key maps to missing transfer");
                }
                GLOBAL_STATE.events.push({
                    type: 'transfer.idempotent_hit',
                    transferId: existingId,
                    idempotencyKey,
                    timestamp: Date.now()
                });
                return existingTransfer;
            }
            // 5. CREATE TRANSFER
            const transferId = `tr_fake_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
            const transfer = {
                id: transferId,
                object: 'transfer',
                amount: params.amount,
                amount_reversed: 0,
                balance_transaction: `txn_fake_${uuidv4()}`,
                created: Math.floor(Date.now() / 1000),
                currency: params.currency,
                description: null,
                destination: params.destination,
                destination_payment: `py_fake_${uuidv4()}`,
                livemode: false,
                metadata: params.metadata || {},
                reversals: { object: 'list', data: [], has_more: false, total_count: 0, url: '' },
                reversed: false,
                source_transaction: null,
                source_type: 'card',
                transfer_group: params.transfer_group || null,
                status: 'paid',
                idempotencyKey
            };
            // 6. MUTATE STATE
            // Update balance
            const currentBal = GLOBAL_STATE.balances.get(params.destination) || 0;
            GLOBAL_STATE.balances.set(params.destination, currentBal + params.amount);
            // Store records
            GLOBAL_STATE.transfers.set(transferId, transfer);
            GLOBAL_STATE.idempotencyKeys.set(idempotencyKey, transferId);
            // Log
            GLOBAL_STATE.events.push({
                type: 'transfer.created',
                transferId,
                idempotencyKey,
                amount: params.amount,
                destination: params.destination,
                timestamp: Date.now()
            });
            return transfer;
        },
        retrieve: async (id) => {
            const transfer = GLOBAL_STATE.transfers.get(id);
            if (!transfer) {
                throw new Error(`Stripe Fake: No such transfer: ${id}`);
            }
            return transfer;
        },
        createReversal: async (id, params, opts) => {
            const idempotencyKey = opts?.idempotencyKey;
            if (!idempotencyKey)
                throw new Error("Stripe Fake: missing idempotency key for reversal");
            if (GLOBAL_STATE.idempotencyKeys.has(idempotencyKey)) {
                // Return mock reversal
                return { id: 'trr_fake_idempotent', transfer: id };
            }
            const transfer = GLOBAL_STATE.transfers.get(id);
            if (!transfer)
                throw new Error(`Transfer ${id} not found`);
            // Deduct balance
            const currentBal = GLOBAL_STATE.balances.get(transfer.destination) || 0;
            GLOBAL_STATE.balances.set(transfer.destination, currentBal - (params.amount || transfer.amount));
            GLOBAL_STATE.idempotencyKeys.set(idempotencyKey, `trr_fake_${uuidv4()}`);
            GLOBAL_STATE.events.push({ type: 'transfer.reversed', transferId: id, timestamp: Date.now() });
            return { id: `trr_fake_${uuidv4()}`, transfer: id };
        }
    };
    paymentIntents = {
        capture: async (id, params, opts) => {
            // Check for failure simulation
            if (GLOBAL_STATE.nextFailure) {
                if (GLOBAL_STATE.nextFailure.count > 0) {
                    GLOBAL_STATE.nextFailure.count--;
                    if (GLOBAL_STATE.nextFailure.type === 'timeout') {
                        throw new Error('StripeConnectionError: Timeout');
                    }
                    throw new Error('StripeError: API Error');
                }
            }
            // Always succeed for fake
            return {
                id,
                object: 'payment_intent',
                amount: 5000,
                status: 'succeeded'
            };
        },
        cancel: async (id, params, opts) => {
            if (!opts?.idempotencyKey)
                throw new Error("Stripe Fake: missing idempotency key for PI cancel");
            GLOBAL_STATE.events.push({ type: 'pi.canceled', transferId: id, timestamp: Date.now() });
            return { id, status: 'canceled' };
        }
    };
    refunds = {
        create: async (params, opts) => {
            if (!opts?.idempotencyKey)
                throw new Error("Stripe Fake: missing idempotency key for refund");
            GLOBAL_STATE.events.push({ type: 'refund.created', amount: params.amount, timestamp: Date.now() });
            return { id: `re_fake_${uuidv4()}`, status: 'succeeded' };
        }
    };
    balance = {
        retrieve: async () => {
            return {
                object: 'balance',
                available: [{ amount: 1000000, currency: 'usd', source_types: { card: 1000000 } }],
                livemode: false,
                pending: [{ amount: 0, currency: 'usd', source_types: { card: 0 } }]
            };
        }
    };
}
//# sourceMappingURL=FakeStripe.js.map