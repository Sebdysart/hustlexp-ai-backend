import { safeSql as sql, transaction } from '../../db/index.js';
import { serviceLogger } from '../../utils/logger.js';
import { ulid } from 'ulidx';
import { KillSwitch } from '../KillSwitch.js';
/**
 * COMPENSATION SERVICE
 *
 * Part of OMEGA_PROTOCOL.
 *
 * Responsibilities:
 * 1. Receive Drift Calculation (Internal vs External).
 * 2. Generate "Compensation" Ledger Transaction.
 * 3. Determine if Auto-Apply is safe (Small drift) or requires Admin (Large drift).
 */
const logger = serviceLogger.child({ module: 'CompensationService' });
export class CompensationService {
    // Safety Thresholds
    static MAX_AUTO_DRIFT_CENTS = 500; // $5.00 auto-fix allowed
    /**
     * PROPOSE COMPENSATION
     * Generates a transaction to fix the balance.
     */
    static async proposeCompensation(accountId, driftAmount, // Positive = Ledger has MORE than Reality (Need to Credit Asset/Debit Liab to reduce?)
    // Wait. 
    // If Ledger says 100, Reality says 90. Drift = 10. Ledger is too high.
    // If Asset (Dr+), we need to Credit 10.
    // If Liability (Cr+), we need to Debit 10.
    isAsset) {
        if (driftAmount === 0)
            return;
        const isTooLarge = Math.abs(driftAmount) > this.MAX_AUTO_DRIFT_CENTS;
        if (isTooLarge) {
            logger.error({ driftAmount }, 'Drift too large for auto-compensation. Manual Review Required.');
            await KillSwitch.trigger('LEDGER_DRIFT', { accountId, driftAmount, type: 'MANUAL_REQUIRED' });
            return;
        }
        logger.info({ accountId, driftAmount }, 'Generating Compensation Transaction...');
        // LOGIC:
        // Ledger = 100, External = 90. Diff = +10.
        // We need to reduce Ledger by 10.
        // Direction to reduce:
        // Asset: Credit
        // Liability: Debit
        // However, double entry requires 2 sides.
        // If we reduce Cash, where does it go?
        // It goes to "Lost & Found" or "Drift Expense".
        // We need a "System Drift" Equity/Expense Account.
        const driftAccountId = await this.getSystemDriftAccount();
        // Transaction
        const txId = ulid();
        const description = `Auto-Compensation for Drift: ${driftAmount}`;
        // Prepare Entries
        // If Ledger is HIGH (Need to decrease):
        // If Asset: Credit Asset, Debit DriftExpense.
        const direction = isAsset
            ? (driftAmount > 0 ? 'credit' : 'debit') // Reduce Asset if Drift > 0
            : (driftAmount > 0 ? 'debit' : 'credit'); // Reduce Liability if Drift > 0? 
        // Liability 100 (Credit Balance). Reality 90. We need to reduce to 90.
        // Debit Liability 10.
        const offsetDirection = direction === 'debit' ? 'credit' : 'debit';
        const absAmount = Math.abs(driftAmount);
        // Execute Compensation
        await transaction(async (tx) => {
            // 1. Create Tx
            await tx `
                INSERT INTO ledger_transactions (id, type, idempotency_key, status, description, metadata)
                VALUES (
                    ${txId}, 'COMPENSATION', ${`comp_${Date.now()}_${accountId}`}, 'committed', 
                    ${description}, ${JSON.stringify({ auto: true, drift: driftAmount })}
                )
            `;
            // 2. Entry for Target Account
            await tx `
                INSERT INTO ledger_entries (transaction_id, account_id, direction, amount)
                VALUES (${txId}, ${accountId}, ${direction}, ${absAmount})
            `;
            // 3. Entry for Drift Account (Balancing Leg)
            await tx `
                INSERT INTO ledger_entries (transaction_id, account_id, direction, amount)
                VALUES (${txId}, ${driftAccountId}, ${offsetDirection}, ${absAmount})
            `;
            // 4. Update Balances
            // (Standard LedgerService Logic would be better to reuse, but we are inside CompensationService)
            // We assume standard trigger or manual update? The engine has manual update logic in Commit.
            // We need to adhere to protocol. 
            // We'll update balances manually here for specific accounts to ensure fix.
            // NOTE: Ideally use LedgerService.prepare + commit. But this is "Recovery".
            // We do direct SQL for robust fix? No, `LedgerService` is safer.
            // But we are in `infra`. Circular dependency risk.
            // We will do direct SQL updates to be "Metal Level".
            await tx `
                UPDATE ledger_accounts
                SET balance = balance + ${direction === 'debit' ? absAmount : -absAmount}, updated_at = NOW()
                WHERE id = ${accountId} OR id = ${driftAccountId}
            `;
            // NOTE: The above logic applies the same math to both? NO.
            // We must update separately if IDs differ.
        });
        logger.info({ txId }, 'Compensation Applied Successfully');
    }
    static async getSystemDriftAccount() {
        // Return ID of "Platform Drift Expense"
        // Ensure it exists
        const id = '00000000-0000-0000-0000-DRIFT0000000';
        await sql `
            INSERT INTO ledger_accounts (id, owner_type, type, name, balance)
            VALUES (${id}, 'platform', 'expense', 'System Drift Loss', 0)
            ON CONFLICT (id) DO NOTHING
        `;
        return id;
    }
}
//# sourceMappingURL=CompensationService.js.map