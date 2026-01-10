import { LedgerTransaction, LedgerAccount, CreateLedgerTransactionInput, LedgerSnapshot, LedgerTransactionStatus } from './types.js';
/**
 * LedgerGuardService: THE FIREWALL OF TRUTH
 *
 * Enforces strict invariants for the Military-Grade Ledger.
 * Violations here result in immediate rejection.
 */
export declare class LedgerGuardService {
    /**
     * 1-4. Validate Transaction Integrity BEFORE Database Write
     * Checks: Cardinality, Cross-Account Rules, Zero-Sum, Currency
     */
    static validateTransactionProposal(input: CreateLedgerTransactionInput, accounts: Map<string, LedgerAccount>): void;
    /**
     * 6. Idempotency Validation
     * Ensures consistent ULID generation and idempotency key constraints.
     */
    static validateIdempotency(tx: LedgerTransaction, providedKey: string): void;
    /**
     * 7. State Transition Validation
     * Enforces strict state machine: PENDING -> EXECUTING -> COMMITTED
     */
    static validateStateTransition(currentStatus: LedgerTransactionStatus, nextStatus: LedgerTransactionStatus): void;
    /**
     * 8. Stripe Replay & Body Validation
     * Ensures strict payload matching for Idempotent/Replay calls.
     */
    static validateStripeReplay(existingTx: LedgerTransaction, newMetadataHash: string): void;
    /**
     * 9. Out-of-Order Protection
     * Ensures Monotonic ULID progression per Account.
     * Rejects "Time Travel" writes.
     */
    static validateMonotonicity(account: LedgerAccount, newTxUlid: string, lastSeenUlid: string | null): void;
    /**
     * 10. Snapshot Checksum Verification
     * Verifies data integrity of snapshots against their hash.
     */
    static verifySnapshotIntegrity(snapshot: LedgerSnapshot): boolean;
    static computeSnapshotHash(accountId: string, balance: bigint, lastUlid: string): string;
    static computeBodyHash(data: any): string;
}
//# sourceMappingURL=LedgerGuardService.d.ts.map