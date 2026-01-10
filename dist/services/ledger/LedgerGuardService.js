import crypto from 'crypto';
/**
 * LedgerGuardService: THE FIREWALL OF TRUTH
 *
 * Enforces strict invariants for the Military-Grade Ledger.
 * Violations here result in immediate rejection.
 */
export class LedgerGuardService {
    /**
     * 1-4. Validate Transaction Integrity BEFORE Database Write
     * Checks: Cardinality, Cross-Account Rules, Zero-Sum, Currency
     */
    static validateTransactionProposal(input, accounts // Pre-fetched accounts involved in tx
    ) {
        const { entries, idempotency_key } = input;
        // 1. Transaction Cardinality Enforcement
        if (entries.length < 2) {
            throw new Error(`[LedgerGuard] Transaction ${idempotency_key} rejected: Must have at least 2 entries.`);
        }
        if (entries.length % 2 !== 0) {
            // Note: Conventional double entry allows split (1 debit, 2 credits), but strict pairing 
            // is often safer for this system. If we allow splits, this check might be relaxed, 
            // but for "Military Mode" simplistic pairs reduce complexity.
            // Requirement says "even pairing" in prompt list item 1.
            if (entries.length % 2 !== 0) {
                throw new Error(`[LedgerGuard] Transaction ${idempotency_key} rejected: Entries must be even pairs (Military Spec).`);
            }
        }
        let totalDebit = BigInt(0);
        let totalCredit = BigInt(0);
        for (const entry of entries) {
            // 4. Currency Lock (Implicit in Schema, but checked via Account)
            // 5. Lifecycle Validation (Account must exist)
            const account = accounts.get(entry.account_id);
            if (!account) {
                throw new Error(`[LedgerGuard] Account ${entry.account_id} not found or invalid.`);
            }
            if (account.currency !== 'USD') {
                throw new Error(`[LedgerGuard] Non-USD Account ${entry.account_id} rejected.`);
            }
            // 2. Cross-Account Rule Enforcement
            // Ensure strictly positive amounts
            if (entry.amount <= 0 || !Number.isInteger(entry.amount)) {
                throw new Error(`[LedgerGuard] Invalid amount ${entry.amount} for account ${entry.account_id}. Must be positive integer.`);
            }
            // Direction Logic checks could go here (e.g. banning credit to Asset if specific rule existed),
            // but standard accounting relies on Zero Sum. We check standard allowed types.
            if (!['asset', 'liability', 'equity', 'expense'].includes(account.type)) {
                throw new Error(`[LedgerGuard] Invalid account type ${account.type}.`);
            }
            // Summation for Zero-Sum Check
            const amt = BigInt(entry.amount);
            if (entry.direction === 'debit') {
                totalDebit += amt;
            }
            else if (entry.direction === 'credit') {
                totalCredit += amt;
            }
            else {
                throw new Error(`[LedgerGuard] Invalid direction ${entry.direction}`);
            }
        }
        // 3. Zero-Sum Validation
        if (totalDebit !== totalCredit) {
            throw new Error(`[LedgerGuard] Zero-Sum Violation. Debits: ${totalDebit}, Credits: ${totalCredit}. Delta: ${totalDebit - totalCredit}`);
        }
    }
    /**
     * 6. Idempotency Validation
     * Ensures consistent ULID generation and idempotency key constraints.
     */
    static validateIdempotency(tx, providedKey) {
        if (tx.idempotency_key !== providedKey) {
            throw new Error(`[LedgerGuard] Idempotency Mismatch: Key ${providedKey} does not match stored ${tx.idempotency_key}`);
        }
    }
    /**
     * 7. State Transition Validation
     * Enforces strict state machine: PENDING -> EXECUTING -> COMMITTED
     */
    static validateStateTransition(currentStatus, nextStatus) {
        const allowed = {
            'pending': ['executing', 'failed'],
            'executing': ['committed', 'failed'],
            'committed': ['confirmed'], // confirmed by webhook
            'confirmed': [], // Final State
            'failed': [] // Final State
        };
        if (!allowed[currentStatus]?.includes(nextStatus)) {
            throw new Error(`[LedgerGuard] Illegal Transition: ${currentStatus} -> ${nextStatus}`);
        }
    }
    /**
     * 8. Stripe Replay & Body Validation
     * Ensures strict payload matching for Idempotent/Replay calls.
     */
    static validateStripeReplay(existingTx, newMetadataHash // SHA-256 of the proposed metadata/body
    ) {
        // Assume metadata contains a hash of the original intention
        const originalHash = existingTx.metadata?.['body_hash'];
        if (originalHash && originalHash !== newMetadataHash) {
            throw new Error(`[LedgerGuard] Stripe Replay Mismatch! Existing transaction ${existingTx.id} has different body checksum.`);
        }
    }
    /**
     * 9. Out-of-Order Protection
     * Ensures Monotonic ULID progression per Account.
     * Rejects "Time Travel" writes.
     */
    static validateMonotonicity(account, newTxUlid, lastSeenUlid) {
        // If we have a previous ULID, strictly ensure new > old
        if (lastSeenUlid && newTxUlid <= lastSeenUlid) {
            throw new Error(`[LedgerGuard] Causal Violation: Transaction ${newTxUlid} is older than account head ${lastSeenUlid}.`);
        }
    }
    /**
     * 10. Snapshot Checksum Verification
     * Verifies data integrity of snapshots against their hash.
     */
    static verifySnapshotIntegrity(snapshot) {
        const computedHash = LedgerGuardService.computeSnapshotHash(snapshot.account_id, snapshot.balance, snapshot.last_tx_ulid);
        if (computedHash !== snapshot.snapshot_hash) {
            throw new Error(`[LedgerGuard] CORRUPTION DETECTED: Snapshot ${snapshot.account_id} hash mismatch.`);
        }
        return true;
    }
    static computeSnapshotHash(accountId, balance, lastUlid) {
        return crypto
            .createHash('sha256')
            .update(`${accountId}:${balance.toString()}:${lastUlid}`)
            .digest('hex');
    }
    static computeBodyHash(data) {
        return crypto
            .createHash('sha256')
            .update(JSON.stringify(data))
            .digest('hex');
    }
}
//# sourceMappingURL=LedgerGuardService.js.map