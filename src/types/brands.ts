/**
 * Branded Nominal Types
 *
 * Prevents passing a TaskId where a UserId is expected — enforced at compile time.
 * Use smart constructors (UserId.parse, TaskId.parse) at system boundaries.
 * Never cast with `as UserId` directly — use the constructors.
 */

declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ─── Core Domain IDs ───────────────────────────────────────────────────────

export type UserId   = Brand<string, 'UserId'>;
export type TaskId   = Brand<string, 'TaskId'>;
export type EscrowId = Brand<string, 'EscrowId'>;
export type PaymentId = Brand<string, 'PaymentId'>;
export type DisputeId = Brand<string, 'DisputeId'>;
export type ProofId  = Brand<string, 'ProofId'>;
export type LedgerEntryId = Brand<string, 'LedgerEntryId'>;

// ─── Monetary amounts (cents, never floats) ───────────────────────────────

export type Cents = Brand<number, 'Cents'>;

// ─── UUID regex ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUUID<T extends Brand<string, string>>(
  raw: string,
  typeName: string,
): T {
  if (!UUID_RE.test(raw)) {
    throw new TypeError(`Invalid UUID for ${typeName}: "${raw}"`);
  }
  return raw as T;
}

// ─── Smart constructors ───────────────────────────────────────────────────

export const UserId = {
  parse:   (raw: string): UserId   => parseUUID<UserId>(raw, 'UserId'),
  isValid: (raw: string): boolean  => UUID_RE.test(raw),
  unsafe:  (raw: string): UserId   => raw as UserId,  // ONLY for DB rows already validated
} as const;

export const TaskId = {
  parse:   (raw: string): TaskId   => parseUUID<TaskId>(raw, 'TaskId'),
  isValid: (raw: string): boolean  => UUID_RE.test(raw),
  unsafe:  (raw: string): TaskId   => raw as TaskId,
} as const;

export const EscrowId = {
  parse:   (raw: string): EscrowId  => parseUUID<EscrowId>(raw, 'EscrowId'),
  isValid: (raw: string): boolean   => UUID_RE.test(raw),
  unsafe:  (raw: string): EscrowId  => raw as EscrowId,
} as const;

export const PaymentId = {
  parse:   (raw: string): PaymentId => parseUUID<PaymentId>(raw, 'PaymentId'),
  isValid: (raw: string): boolean   => UUID_RE.test(raw),
  unsafe:  (raw: string): PaymentId => raw as PaymentId,
} as const;

export const DisputeId = {
  parse:   (raw: string): DisputeId => parseUUID<DisputeId>(raw, 'DisputeId'),
  isValid: (raw: string): boolean   => UUID_RE.test(raw),
  unsafe:  (raw: string): DisputeId => raw as DisputeId,
} as const;

export const ProofId = {
  parse:   (raw: string): ProofId   => parseUUID<ProofId>(raw, 'ProofId'),
  isValid: (raw: string): boolean   => UUID_RE.test(raw),
  unsafe:  (raw: string): ProofId   => raw as ProofId,
} as const;

export const Cents = {
  fromNumber: (n: number): Cents => {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`Cents must be a non-negative integer, got: ${n}`);
    }
    return n as Cents;
  },
  unsafe: (n: number): Cents => n as Cents,
} as const;
