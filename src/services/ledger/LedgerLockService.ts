
import { query } from '../../db/index.js';

/**
 * LEDGER LOCK SERVICE (Ring 1)
 * 
 * Manages Application-Level locks ('ledger_locks') to coordinate
 * concurrent financial operations on the same resource (Task/User)
 * BEFORE reaching the core database transaction efficiency.
 */
export class LedgerLockService {

    /**
     * Acquire a lock for a resource.
     * @param resourceId - E.g. "task:uuid"
     * @param txId - The ULID of the transaction requesting the lock
     * @param ttlSeconds - Time to live
     */
    static async acquire(resourceId: string, txId: string, ttlSeconds: number = 30): Promise<{ acquired: boolean, leaseId: string }> {
        // Use `query` (Pool) to match M4 Runner connection style

        try {
            await query(`
                INSERT INTO ledger_locks (resource_id, owner_ulid, expires_at)
                VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
            `, [resourceId, txId, ttlSeconds]);

            return { acquired: true, leaseId: txId };
        } catch (err: any) {

            // Debugging common error
            if (String(err).includes('relation "ledger_locks" does not exist')) {
                console.error('[LedgerLock] CRITICAL: Table "ledger_locks" missing via Pool Query.');
                throw err;
            }

            // Check existing
            const existing = await query<any>(`
                SELECT owner_ulid, expires_at FROM ledger_locks WHERE resource_id = $1
            `, [resourceId]);

            if (existing && existing.length > 0) {
                const lock = existing[0];
                const now = new Date();

                if (lock.owner_ulid === txId) {
                    return { acquired: true, leaseId: txId };
                }

                if (new Date(lock.expires_at) < now) {
                    const result = await query<any>(`
                        UPDATE ledger_locks 
                        SET owner_ulid = $1, expires_at = now() + ($2 || ' seconds')::interval
                        WHERE resource_id = $3 AND owner_ulid = $4
                        RETURNING resource_id
                    `, [txId, ttlSeconds, resourceId, lock.owner_ulid]);

                    if (!result || result.length === 0) {
                        throw new Error(`[LedgerLock] Failed to steal expired lock for ${resourceId}. Race condition.`);
                    }
                    return { acquired: true, leaseId: txId };
                }

                throw new Error(`[LedgerLock] Resource ${resourceId} is locked by tx ${lock.owner_ulid}`);
            } else {
                // If checking found nothing but insert failed, it's a race or error
                throw err;
            }
        }
    }

    /**
     * ACQUIRE BATCH (Deadlock-Safe)
     * Acquires locks for multiple resources in specific order (Sorted IDs).
     * All or Nothing.
     */
    static async acquireBatch(resources: string[], txId: string, ttlSeconds: number = 30): Promise<{ acquired: boolean, leaseId: string }> {
        const sortedResources = [...new Set(resources)].sort();
        const acquiredSoFar: string[] = [];

        try {
            for (const res of sortedResources) {
                const result = await this.acquire(res, txId, ttlSeconds);
                if (result.acquired) {
                    acquiredSoFar.push(res);
                }
            }
            return { acquired: true, leaseId: txId };
        } catch (err) {
            console.error(`[LedgerLock] Batch acquisition failed. Rolling back ${acquiredSoFar.length} locks.`);
            // Rollback
            await Promise.all(acquiredSoFar.map(res => this.release(res, txId)));
            throw err; // Re-throw
        }
    }

    /**
     * Release a lock.
     * Only the owner can release it.
     */
    static async release(resourceId: string, txId: string): Promise<void> {
        await query(`
            DELETE FROM ledger_locks 
            WHERE resource_id = $1 AND owner_ulid = $2
        `, [resourceId, txId]);
    }
}
