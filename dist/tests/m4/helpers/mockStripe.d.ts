/**
 * MOCK STRIPE CLIENT for M4 Runner
 * Supports:
 * - Deterministic Transfers
 * - Idempotency Replay
 * - Fault Injection
 */
export declare class MockStripe {
    private transfersMap;
    private faultConfig;
    config(faults: Partial<typeof this.faultConfig>): void;
    paymentIntents: {
        create: (params: any, options: {
            idempotencyKey: string;
        }) => Promise<any>;
        confirm: (id: string, params: any, options: {
            idempotencyKey: string;
        }) => Promise<{
            id: string;
            status: string;
            latest_charge: string;
        }>;
        capture: (id: string, params: any, options: {
            idempotencyKey: string;
        }) => Promise<{
            id: string;
            status: string;
        }>;
        retrieve: (id: string) => Promise<{
            id: string;
            status: string;
            latest_charge: string;
        }>;
        cancel: (id: string) => Promise<{
            id: string;
            status: string;
        }>;
    };
    refunds: {
        create: (params: any, options: {
            idempotencyKey: string;
        }) => Promise<any>;
    };
    transfers: {
        create: (params: any, options: {
            idempotencyKey: string;
        }) => Promise<any>;
        createReversal: (id: string, params: any, options: {
            idempotencyKey: string;
        }) => Promise<any>;
    };
    private _mockResponse;
    reset(): void;
}
export declare const mockStripe: MockStripe;
//# sourceMappingURL=mockStripe.d.ts.map