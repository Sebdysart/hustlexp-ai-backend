import { db } from '../db.js';
import { escrowLogger } from '../logger.js';
import type { EscrowState } from '../types.js';
import { TERMINAL_ESCROW_STATES } from '../types.js';

export interface CreateEscrowParams { taskId: string; amount: number }
export interface FundEscrowParams { escrowId: string; stripePaymentIntentId: string }
export interface ReleaseEscrowParams {
  escrowId: string;
  stripeTransferId?: string;
  localTestTransferId?: string;
  adminOverride?: boolean;
  reason?: string;
}
export interface RefundEscrowParams { escrowId: string; adminOverride?: boolean; reason?: string }
export interface PartialRefundParams { escrowId: string; workerPercent: number; posterPercent: number }

const VALID_TRANSITIONS: Record<EscrowState, EscrowState[]> = {
  PENDING: ['FUNDED', 'REFUNDED'],
  FUNDED: ['RELEASED', 'REFUNDED', 'LOCKED_DISPUTE'],
  LOCKED_DISPUTE: ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'],
  RELEASED: [],
  REFUNDED: [],
  REFUND_PARTIAL: [],
};

export function isTerminalEscrowState(state: EscrowState): boolean {
  return TERMINAL_ESCROW_STATES.includes(state);
}

export function isValidEscrowTransition(from: EscrowState, to: EscrowState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidEscrowTransitions(state: EscrowState): EscrowState[] {
  return VALID_TRANSITIONS[state] ?? [];
}

type EscrowEventArguments = [
  escrowId: string,
  fromState: string,
  toState: string,
  actorId?: string,
  actorType?: string,
  metadata?: Record<string, unknown>,
  idempotencyKey?: string,
];

export async function logEscrowEvent(...args: EscrowEventArguments): Promise<void> {
  const [escrowId, fromState, toState, actorId, actorType = 'system', metadata = {}, idempotencyKey] = args;
  try {
    await db.query(
      `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [escrowId, fromState, toState, actorId ?? null, actorType, JSON.stringify(metadata), idempotencyKey ?? null],
    );
  } catch (error) {
    escrowLogger.error({ err: error instanceof Error ? error.message : String(error), escrowId }, 'Failed to log escrow event');
  }
}
