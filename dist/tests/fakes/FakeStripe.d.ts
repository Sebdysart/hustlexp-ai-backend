/**
 * FULL STRIPE FAKE — DETERMINISTIC SPEC (NON-NEGOTIABLE)
 *
 * Objective:
 * 1. Prove money correctness without real Stripe
 * 2. Run moneyFlow tests with ZERO skips
 * 3. Detect double-charge, replay, race, and retry bugs
 * 4. Fail loudly when invariants are violated
 * 5. Simulate Stripe behavior deterministically
 */
export interface StripeLike {
    transfers: {
        create(params: TransferCreateParams, opts?: IdempotencyOpts): Promise<Transfer>;
        retrieve(id: string): Promise<Transfer>;
    };
    paymentIntents: {
        capture(id: string, params?: any, opts?: IdempotencyOpts): Promise<PaymentIntent>;
    };
    balance: {
        retrieve(): Promise<any>;
    };
}
export interface PaymentIntent {
    id: string;
    object: 'payment_intent';
    amount: number;
    status: string;
}
interface TransferCreateParams {
    amount: number;
    currency: string;
    destination: string;
    transfer_group?: string;
    metadata?: Record<string, string>;
}
interface IdempotencyOpts {
    idempotencyKey?: string;
}
export interface Transfer {
    id: string;
    object: 'transfer';
    amount: number;
    amount_reversed: number;
    balance_transaction: string | null;
    created: number;
    currency: string;
    description: string | null;
    destination: string | null;
    destination_payment: string | null;
    livemode: boolean;
    metadata: Record<string, string>;
    reversals: any;
    reversed: boolean;
    source_transaction: string | null;
    source_type: string;
    transfer_group: string | null;
    status?: string;
    idempotencyKey?: string;
}
interface StripeEventLog {
    type: string;
    transferId?: string;
    idempotencyKey?: string;
    amount?: number;
    destination?: string;
    timestamp: number;
    error?: string;
}
/**
 * GLOBAL SINGLETON STATE
 * Persists for the entire test run, explicitly reset via FakeStripe.reset()
 */
declare class FakeStripeState {
    balances: Map<string, number>;
    transfers: Map<string, Transfer>;
    idempotencyKeys: Map<string, string>;
    events: StripeEventLog[];
    nextFailure: {
        type: 'timeout' | 'api_error';
        count: number;
    } | null;
    reset(): void;
}
export declare class FakeStripe implements StripeLike {
    static state: FakeStripeState;
    static reset(): void;
    static failNext(type: 'timeout' | 'api_error', count?: number): void;
    transfers: {
        create: (params: TransferCreateParams, opts?: IdempotencyOpts) => Promise<Transfer>;
        retrieve: (id: string) => Promise<Transfer>;
        createReversal: (id: string, params: any, opts?: IdempotencyOpts) => Promise<{
            id: string;
            transfer: string;
        }>;
    };
    paymentIntents: {
        capture: (id: string, params?: any, opts?: IdempotencyOpts) => Promise<PaymentIntent>;
        cancel: (id: string, params?: any, opts?: IdempotencyOpts) => Promise<{
            id: string;
            status: string;
        }>;
    };
    refunds: {
        create: (params: any, opts?: IdempotencyOpts) => Promise<{
            id: string;
            status: string;
        }>;
    };
    balance: {
        retrieve: () => Promise<any>;
    };
}
export {};
//# sourceMappingURL=FakeStripe.d.ts.map