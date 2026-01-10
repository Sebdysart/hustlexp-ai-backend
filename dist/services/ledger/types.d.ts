/**
 * MILITARY-GRADE LEDGER TYPES
 *
 * Enforced Types for the Double-Entry Ledger System.
 * USD-Only. Integer Cents. Mutable Status.
 */
export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'expense';
export type LedgerEntryDirection = 'debit' | 'credit';
export type LedgerTransactionStatus = 'pending' | 'executing' | 'committed' | 'confirmed' | 'failed';
export interface LedgerAccount {
    id: string;
    owner_type: 'platform' | 'user' | 'task';
    owner_id: string | null;
    type: LedgerAccountType;
    currency: 'USD';
    balance: bigint;
    baseline_balance: bigint;
    baseline_tx_ulid: string | null;
    metadata: Record<string, any>;
    created_at: Date;
}
export interface LedgerTransaction {
    id: string;
    type: string;
    idempotency_key: string;
    status: LedgerTransactionStatus;
    metadata: Record<string, any>;
    created_at: Date;
    committed_at?: Date;
}
export interface LedgerEntry {
    transaction_id: string;
    account_id: string;
    direction: LedgerEntryDirection;
    amount: bigint;
}
export interface LedgerSnapshot {
    account_id: string;
    balance: bigint;
    last_tx_ulid: string;
    snapshot_hash: string;
    created_at: Date;
}
export interface CreateLedgerEntryInput {
    account_id: string;
    direction: LedgerEntryDirection;
    amount: number;
}
export interface CreateLedgerTransactionInput {
    idempotency_key: string;
    type: string;
    metadata?: Record<string, any>;
    entries: CreateLedgerEntryInput[];
}
//# sourceMappingURL=types.d.ts.map