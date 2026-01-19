/**
 * Task State Machine Helper (Phase N2.2 Cleanup)
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Centralizes task state transition legality checks.
 * Prevents illegal state transitions at the handler level.
 * 
 * ============================================================================
 * CANONICAL STATE MACHINE
 * ============================================================================
 * 
 * OPEN → EN_ROUTE (ACCEPTED) → WORKING → COMPLETED
 * 
 * TERMINAL STATES: COMPLETED, CANCELLED, EXPIRED
 * 
 * ============================================================================
 * NOTES
 * ============================================================================
 * 
 * - EN_ROUTE maps to ACCEPTED in schema (conceptual vs. storage)
 * - PROOF_SUBMITTED is legacy and not used in execution flow
 * - All transitions are validated server-side before DB writes
 * 
 * Reference: Phase N2.2 Final Authority Resolution
 */

import { TRPCError } from '@trpc/server';

export type TaskState = 
  | 'OPEN'
  | 'ACCEPTED'  // Maps to EN_ROUTE conceptually
  | 'WORKING'
  | 'PROOF_SUBMITTED'  // Legacy, kept for compatibility
  | 'DISPUTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

/**
 * Legal state transitions (canonical)
 */
export const LEGAL_TRANSITIONS: Record<TaskState, TaskState[]> = {
  OPEN: ['ACCEPTED'], // OPEN → EN_ROUTE (ACCEPTED)
  ACCEPTED: ['WORKING'], // EN_ROUTE (ACCEPTED) → WORKING
  WORKING: ['COMPLETED'], // WORKING → COMPLETED
  PROOF_SUBMITTED: ['COMPLETED', 'DISPUTED'], // Legacy flow
  DISPUTED: ['COMPLETED', 'CANCELLED'], // Legacy flow
  COMPLETED: [], // Terminal
  CANCELLED: [], // Terminal
  EXPIRED: [], // Terminal
};

/**
 * Assert that a state transition is legal
 * 
 * Throws TRPCError if transition is illegal
 */
export function assertTransition(from: TaskState, to: TaskState): void {
  const allowed = LEGAL_TRANSITIONS[from];
  
  if (!allowed) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Unknown task state: ${from}`,
    });
  }

  if (!allowed.includes(to)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Illegal task state transition: ${from} → ${to}. Allowed transitions from ${from}: ${allowed.join(', ')}`,
    });
  }
}

/**
 * Check if a state is terminal (immutable)
 */
export function isTerminalState(state: TaskState): boolean {
  return ['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(state);
}

/**
 * Check if a state is part of execution flow
 */
export function isExecutionState(state: TaskState): boolean {
  return ['OPEN', 'ACCEPTED', 'WORKING'].includes(state);
}
