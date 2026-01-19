import { sql } from '../../db/index.js';
import crypto from 'crypto';
const TEMPLATE_DEFINITIONS = {
    // Platform
    'platform_cash': { type: 'asset', prefix: 'Platform Cash', scope: 'platform' },
    'platform_escrow': { type: 'liability', prefix: 'Platform Escrow', scope: 'platform' },
    'platform_revenue': { type: 'equity', prefix: 'Platform Revenue', scope: 'platform' },
    'platform_stripe_fees': { type: 'expense', prefix: 'Platform Stripe Fees', scope: 'platform' },
    'platform_dispute_hold': { type: 'liability', prefix: 'Platform Dispute Hold', scope: 'platform' },
    // User
    'receivable': { type: 'asset', prefix: 'User Receivable', scope: 'user' },
    'payable': { type: 'liability', prefix: 'User Payable', scope: 'user' },
    'user_escrow': { type: 'liability', prefix: 'User Escrow', scope: 'user' },
    // Task
    'task_escrow': { type: 'liability', prefix: 'Task Escrow', scope: 'task' }
};
export const PLATFORM_OWNER_ID = '00000000-0000-0000-0000-000000000000'; // Null replacement/Constant
/**
 * LEDGER ACCOUNT SERVICE
 * "The Root of Correctness"
 *
 * Responsibilities:
 * 1. Deterministic Account ID Generation
 * 2. Auto-Creation with Templates
 * 3. FOR UPDATE Locking
 */
export class LedgerAccountService {
    /**
     * Compute Deterministic UUID for an account.
     * Strategy: UUID seeded SHA256(ownerId + ":" + templateType)
     */
    static computeId(ownerId, template) {
        const input = `${ownerId}:${template}`;
        const hash = crypto.createHash('sha256').update(input).digest('hex');
        // Format as UUID (8-4-4-4-12) from first 32 hex chars
        return [
            hash.substring(0, 8),
            hash.substring(8, 12),
            hash.substring(12, 16),
            hash.substring(16, 20),
            hash.substring(20, 32)
        ].join('-');
    }
    /**
     * Get or Create an Account (Atomic/Safe).
     * Must be called within an active transaction context if 'client' is provided.
     * If 'client' is not provided, uses global sql (auto-commit), but this is RISKY for sequential ops.
     * ALWAYS PROVIDE CLIENT IN SAGA.
     */
    static async getAccount(ownerId, template, client = sql // specific transaction client
    ) {
        const def = TEMPLATE_DEFINITIONS[template];
        if (!def)
            throw new Error(`[LedgerAccount] Invalid template: ${template}`);
        // Validate scope
        if (def.scope === 'platform' && ownerId !== PLATFORM_OWNER_ID) {
            throw new Error(`[LedgerAccount] Platform accounts must use PLATFORM_OWNER_ID`);
        }
        const accountId = LedgerAccountService.computeId(ownerId, template);
        // 1. Try to fetch with LOCK (Ring 2 requirement)
        // Note: 'FOR UPDATE' only works if we are in a transaction block. 
        // We assume 'client' is a transaction object if inside the Saga.
        // We TRY to read first.
        const [existing] = await client `
            SELECT * FROM ledger_accounts WHERE id = ${accountId} FOR UPDATE SKIP LOCKED
        `;
        // Note: SKIP LOCKED might return nothing if locked. 
        // But if we want to wait, we use FOR UPDATE.
        // Prompt says "Look it up with FOR UPDATE".
        // Let's do a plain SELECT first to see if it exists, then Lock if necessary?
        // No, best pattern: INSERT ON CONFLICT DO NOTHING RETURNING * is standard for "Get or Create"
        // But we need to lock it if it exists.
        // Correct Pattern:
        // 1. INSERT (...) ON CONFLICT (id) DO NOTHING
        // 2. SELECT * FROM ... WHERE id = ... FOR UPDATE
        // NOTE: We need to populate the insert fields correctly based on template.
        const name = `${def.prefix} [${ownerId.substring(0, 8)}]`;
        // We can't use 'client' for INSERT if it's just 'sql', but typically it is.
        // We accept that this might create the account.
        await client `
            INSERT INTO ledger_accounts (
                id, owner_id, owner_type, type, currency, name, balance, baseline_balance
            ) VALUES (
                ${accountId}, 
                ${ownerId === PLATFORM_OWNER_ID ? null : ownerId}, 
                ${def.scope}, 
                ${def.type}, 
                'USD', 
                ${name}, 
                0, 
                0
            )
            ON CONFLICT (id) DO NOTHING
        `;
        // Now select it with lock
        const [account] = await client `
            SELECT * FROM ledger_accounts WHERE id = ${accountId} FOR UPDATE
        `;
        if (!account) {
            // Should be impossible unless delete happened or massive race
            throw new Error(`[LedgerAccount] Failed to obtain account ${accountId} after creation.`);
        }
        return account;
    }
    /**
     * Helper to get Platform Connection ID.
     * In a real app this might come from ENV or Config.
     * Using constant for now as per prompt instructions regarding "Platform Accounts".
     */
    static getPlatformId() {
        return PLATFORM_OWNER_ID;
    }
}
//# sourceMappingURL=LedgerAccountService.js.map