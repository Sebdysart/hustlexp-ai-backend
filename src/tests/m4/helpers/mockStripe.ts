
/**
 * MOCK STRIPE CLIENT for M4 Runner
 * Supports:
 * - Deterministic Transfers
 * - Idempotency Replay
 * - Fault Injection
 */

export class MockStripe {
    private transfersMap: Map<string, any> = new Map();
    private faultConfig: {
        shouldFail: boolean;
        errorCode?: string;
        delayMs: number;
    } = { shouldFail: false, delayMs: 10 };

    // Allows M4 Runner to configure faults dynamically per test case
    config(faults: Partial<typeof this.faultConfig>) {
        this.faultConfig = { ...this.faultConfig, ...faults };
    }



    paymentIntents = {
        create: async (params: any, options: { idempotencyKey: string }) => {
            return this._mockResponse('pi', params, options);
        },
        confirm: async (id: string, params: any, options: { idempotencyKey: string }) => {
            return {
                id,
                status: 'requires_capture',
                latest_charge: `ch_mock_${id.split('_')[2] || 'gen'}`
            };
        },
        capture: async (id: string, params: any, options: { idempotencyKey: string }) => {
            return {
                id,
                status: 'succeeded'
            };
        },
        retrieve: async (id: string) => {
            return {
                id,
                status: 'requires_capture',
                latest_charge: `ch_mock_${id.split('_')[2] || 'gen'}`
            };
        },
        cancel: async (id: string) => {
            return { id, status: 'canceled' };
        }
    };

    refunds = {
        create: async (params: any, options: { idempotencyKey: string }) => {
            return this._mockResponse('re', params, options);
        }
    };

    transfers = {
        create: async (params: any, options: { idempotencyKey: string }) => {
            return this._mockResponse('tr', params, options);
        },
        createReversal: async (id: string, params: any, options: { idempotencyKey: string }) => {
            return { id: `trr_mock_${id.substring(3)}`, ...params };
        }
    };

    private async _mockResponse(prefix: string, params: any, options: { idempotencyKey: string }) {
        const { idempotencyKey } = options || {};
        await new Promise(resolve => setTimeout(resolve, this.faultConfig.delayMs));

        if (idempotencyKey && this.transfersMap.has(idempotencyKey)) {
            return this.transfersMap.get(idempotencyKey);
        }

        if (this.faultConfig.shouldFail) {
            const err: any = new Error(this.faultConfig.errorCode || 'Stripe API Error');
            err.code = this.faultConfig.errorCode || 'api_error';
            throw err;
        }

        const response = {
            id: `${prefix}_mock_${Math.random().toString(36).substring(7)}`,
            object: 'mock_obj',
            ...params,
            created: Math.floor(Date.now() / 1000)
        };

        if (idempotencyKey) this.transfersMap.set(idempotencyKey, response);
        return response;
    }

    // Reset state between tests
    reset() {
        this.transfersMap.clear();
        this.faultConfig = { shouldFail: false, delayMs: 10 };
    }
}

export const mockStripe = new MockStripe();
