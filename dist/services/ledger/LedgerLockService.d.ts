/**
 * LEDGER LOCK SERVICE (Ring 1)
 *
 * Manages Application-Level locks ('ledger_locks') to coordinate
 * concurrent financial operations on the same resource (Task/User)
 * BEFORE reaching the core database transaction efficiency.
 */
export declare class LedgerLockService {
    /**
     * Acquire a lock for a resource.
     * @param resourceId - E.g. "task:uuid"
     * @param txId - The ULID of the transaction requesting the lock
     * @param ttlSeconds - Time to live
     */
    static acquire(resourceId: string, txId: string, ttlSeconds?: number): Promise<{
        acquired: boolean;
        leaseId: string;
    }>;
    /**
     * ACQUIRE BATCH (Deadlock-Safe)
     * Acquires locks for multiple resources in specific order (Sorted IDs).
     * All or Nothing.
     */
    static acquireBatch(resources: string[], txId: string, ttlSeconds?: number): Promise<{
        acquired: boolean;
        leaseId: string;
    }>;
    /**
     * Release a lock.
     * Only the owner can release it.
     */
    static release(resourceId: string, txId: string): Promise<void>;
}
//# sourceMappingURL=LedgerLockService.d.ts.map