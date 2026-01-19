/**
 * Verification State Machine Helper (Phase N2.4)
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Centralizes verification status transition legality checks.
 * Prevents illegal status transitions at the resolution handler level.
 * 
 * ============================================================================
 * CANONICAL STATE MACHINE
 * ============================================================================
 * 
 * PENDING → APPROVED
 * PENDING → REJECTED
 * APPROVED → EXPIRED
 * 
 * TERMINAL STATES: REJECTED, EXPIRED
 * 
 * ============================================================================
 * NOTES
 * ============================================================================
 * 
 * - All transitions are validated server-side before DB writes
 * - Terminal states (REJECTED, EXPIRED) cannot transition to anything
 * - APPROVED cannot transition to REJECTED (only to EXPIRED)
 * - No transition back to PENDING is allowed
 * 
 * Reference: Phase N2.4 — Verification Resolution (LOCKED)
 */

import { TRPCError } from '@trpc/server';

export type VerificationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/**
 * Legal status transitions (canonical)
 */
const ALLOWED_TRANSITIONS: Record<VerificationStatus, Set<VerificationStatus>> = {
  PENDING: new Set(['APPROVED', 'REJECTED']),
  APPROVED: new Set(['EXPIRED']),
  REJECTED: new Set([]), // Terminal
  EXPIRED: new Set([]), // Terminal
};

/**
 * Assert that a verification status transition is legal
 * 
 * Throws TRPCError if transition is illegal
 */
export function assertVerificationTransition(
  from: VerificationStatus,
  to: VerificationStatus
): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  
  if (!allowed) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Unknown verification status: ${from}`,
    });
  }

  if (!allowed.has(to)) {
    const allowedList = Array.from(allowed).join(', ') || 'none (terminal state)';
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Illegal verification status transition: ${from} → ${to}. Allowed transitions from ${from}: ${allowedList}`,
    });
  }
}

/**
 * Check if a status is terminal (immutable)
 */
export function isTerminalVerificationStatus(status: VerificationStatus): boolean {
  return ['REJECTED', 'EXPIRED'].includes(status);
}

/**
 * Check if a status allows resolution
 */
export function canResolve(status: VerificationStatus): boolean {
  return status === 'PENDING' || status === 'APPROVED';
}
