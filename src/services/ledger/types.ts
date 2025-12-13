
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
    id: string; // UUID
    owner_type: 'platform' | 'user' | 'task';
    owner_id: string | null; // UUID
    type: LedgerAccountType;
    currency: 'USD';
    balance: bigint;
    baseline_balance: bigint;
    baseline_tx_ulid: string | null;
    metadata: Record<string, any>;
    created_at: Date;
}

export interface LedgerTransaction {
    id: string; // ULID
    type: string; // e.g., 'ESCROW_HOLD'
    idempotency_key: string;
    status: LedgerTransactionStatus;
    metadata: Record<string, any>;
    created_at: Date;
    committed_at?: Date;
}

export interface LedgerEntry {
    transaction_id: string; // ULID
    account_id: string; // UUID
    direction: LedgerEntryDirection;
    amount: bigint; // Integer Cents, > 0
}

export interface LedgerSnapshot {
    account_id: string; // UUID
    balance: bigint;
    last_tx_ulid: string;
    snapshot_hash: string; // SHA-256
    created_at: Date;
}

// Input Types for Transaction Creation
export interface CreateLedgerEntryInput {
    account_id: string;
    direction: LedgerEntryDirection;
    amount: number; // Integer cents
}

export interface CreateLedgerTransactionInput {
    idempotency_key: string;
    type: string;
    metadata?: Record<string, any>;
    entries: CreateLedgerEntryInput[];
}
