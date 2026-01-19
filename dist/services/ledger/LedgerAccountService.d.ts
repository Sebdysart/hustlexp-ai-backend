import { LedgerAccount } from './types.js';
/**
 * LEDGER ACCOUNT TEMPLATES
 * Defines the strict schema for every account type in the system.
 */
export type LedgerAccountTemplate = 'platform_cash' | 'platform_escrow' | 'platform_revenue' | 'platform_stripe_fees' | 'platform_dispute_hold' | 'receivable' | 'payable' | 'user_escrow' | 'task_escrow';
export declare const PLATFORM_OWNER_ID = "00000000-0000-0000-0000-000000000000";
/**
 * LEDGER ACCOUNT SERVICE
 * "The Root of Correctness"
 *
 * Responsibilities:
 * 1. Deterministic Account ID Generation
 * 2. Auto-Creation with Templates
 * 3. FOR UPDATE Locking
 */
export declare class LedgerAccountService {
    /**
     * Compute Deterministic UUID for an account.
     * Strategy: UUID seeded SHA256(ownerId + ":" + templateType)
     */
    static computeId(ownerId: string, template: LedgerAccountTemplate): string;
    /**
     * Get or Create an Account (Atomic/Safe).
     * Must be called within an active transaction context if 'client' is provided.
     * If 'client' is not provided, uses global sql (auto-commit), but this is RISKY for sequential ops.
     * ALWAYS PROVIDE CLIENT IN SAGA.
     */
    static getAccount(ownerId: string, template: LedgerAccountTemplate, client?: any): Promise<LedgerAccount>;
    /**
     * Helper to get Platform Connection ID.
     * In a real app this might come from ENV or Config.
     * Using constant for now as per prompt instructions regarding "Platform Accounts".
     */
    static getPlatformId(): string;
}
//# sourceMappingURL=LedgerAccountService.d.ts.map