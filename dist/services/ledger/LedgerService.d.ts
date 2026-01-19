import { LedgerTransaction, CreateLedgerTransactionInput } from './types.js';
/**
 * LEDGER SERVICE (The Iron Pipeline)
 *
 * Orchestrates the "Hard-Mode" Saga:
 * 1. Ring 1 Lock (App) - Managed Externally or Internally check?
 *    (Option B: Managed by caller typically, or we check ownership)
 * 2. Guard Validation
 * 3. Ring 2 Lock (DB) - Via injected `client`
 * 4. Pending Write
 * 5. Saga State Management
 */
export declare class LedgerService {
    /**
     * PREPARE TRANSACTION (Step 1 of Saga)
     * Must be called within an active DB Transaction (`client`).
     */
    static prepareTransaction(input: CreateLedgerTransactionInput, client: any): Promise<LedgerTransaction>;
    /**
     * COMMIT TRANSACTION (Step 3 of Saga)
     * Must be called within an active DB Transaction (`client`).
     */
    static commitTransaction(txId: string, stripeMetadata: any, client: any): Promise<void>;
    /**
     * MARK FAILED (Step 3b of Saga)
     */
    static markFailed(txId: string, reason: string, client: any): Promise<void>;
    /**
     * SAGA EXECUTION HELPERS
     */
    static setExecuting(txId: string, client: any): Promise<void>;
}
//# sourceMappingURL=LedgerService.d.ts.map