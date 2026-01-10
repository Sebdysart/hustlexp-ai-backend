/**
 * MOCK STRIPE CLIENT for M4 Runner
 * Supports:
 * - Deterministic Transfers
 * - Idempotency Replay
 * - Fault Injection
 */
export class MockStripe {
    transfersMap = new Map();
    faultConfig = { shouldFail: false, delayMs: 10 };
    // Allows M4 Runner to configure faults dynamically per test case
    config(faults) {
        this.faultConfig = { ...this.faultConfig, ...faults };
    }
    paymentIntents = {
        create: async (params, options) => {
            return this._mockResponse('pi', params, options);
        },
        confirm: async (id, params, options) => {
            return {
                id,
                status: 'requires_capture',
                latest_charge: `ch_mock_${id.split('_')[2] || 'gen'}`
            };
        },
        capture: async (id, params, options) => {
            return {
                id,
                status: 'succeeded'
            };
        },
        retrieve: async (id) => {
            return {
                id,
                status: 'requires_capture',
                latest_charge: `ch_mock_${id.split('_')[2] || 'gen'}`
            };
        },
        cancel: async (id) => {
            return { id, status: 'canceled' };
        }
    };
    refunds = {
        create: async (params, options) => {
            return this._mockResponse('re', params, options);
        }
    };
    transfers = {
        create: async (params, options) => {
            return this._mockResponse('tr', params, options);
        },
        createReversal: async (id, params, options) => {
            return { id: `trr_mock_${id.substring(3)}`, ...params };
        }
    };
    async _mockResponse(prefix, params, options) {
        const { idempotencyKey } = options || {};
        await new Promise(resolve => setTimeout(resolve, this.faultConfig.delayMs));
        if (idempotencyKey && this.transfersMap.has(idempotencyKey)) {
            return this.transfersMap.get(idempotencyKey);
        }
        if (this.faultConfig.shouldFail) {
            const err = new Error(this.faultConfig.errorCode || 'Stripe API Error');
            err.code = this.faultConfig.errorCode || 'api_error';
            throw err;
        }
        const response = {
            id: `${prefix}_mock_${Math.random().toString(36).substring(7)}`,
            object: 'mock_obj',
            ...params,
            created: Math.floor(Date.now() / 1000)
        };
        if (idempotencyKey)
            this.transfersMap.set(idempotencyKey, response);
        return response;
    }
    // Reset state between tests
    reset() {
        this.transfersMap.clear();
        this.faultConfig = { shouldFail: false, delayMs: 10 };
    }
}
export const mockStripe = new MockStripe();
//# sourceMappingURL=mockStripe.js.map