/**
 * EscrowService v1.0.0
 * 
 * CONSTITUTIONAL: Enforces INV-2, INV-4
 * 
 * INV-2: Escrow can only be RELEASED if task is COMPLETED
 * INV-4: Escrow amount is immutable after creation
 * 
 * This service does NOT pre-check invariants — it relies on
 * database triggers to enforce them. This is correct architecture:
 * the database is the single source of truth.
 * 
 * @see schema.sql §1.3 (escrows table)
 * @see PRODUCT_SPEC.md §4
 */

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../db';
import type { 
  Escrow, 
  EscrowState, 
  ServiceResult,
  ServiceError 
} from '../types';
import { TERMINAL_ESCROW_STATES, ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface CreateEscrowParams {
  taskId: string;
  amount: number; // USD cents
}

interface FundEscrowParams {
  escrowId: string;
  stripePaymentIntentId: string;
}

interface ReleaseEscrowParams {
  escrowId: string;
  stripeTransferId?: string;
}

interface RefundEscrowParams {
  escrowId: string;
}

interface PartialRefundParams {
  escrowId: string;
  workerPercent: number;
  posterPercent: number;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

const VALID_TRANSITIONS: Record<EscrowState, EscrowState[]> = {
  PENDING: ['FUNDED', 'REFUNDED'],
  FUNDED: ['RELEASED', 'REFUNDED', 'LOCKED_DISPUTE'],
  LOCKED_DISPUTE: ['REFUNDED', 'REFUND_PARTIAL'], // P0: Policy 1 - LOCKED_DISPUTE blocks RELEASED until dispute resolution
  RELEASED: [],      // TERMINAL
  REFUNDED: [],      // TERMINAL
  REFUND_PARTIAL: [], // TERMINAL
};

function isTerminalState(state: EscrowState): boolean {
  return TERMINAL_ESCROW_STATES.includes(state);
}

function isValidTransition(from: EscrowState, to: EscrowState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// SERVICE
// ============================================================================

export const EscrowService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get escrow by ID
   */
  getById: async (escrowId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>(
        'SELECT * FROM escrows WHERE id = $1',
        [escrowId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Escrow ${escrowId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get escrow by task ID
   */
  getByTaskId: async (taskId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>(
        'SELECT * FROM escrows WHERE task_id = $1',
        [taskId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `No escrow found for task ${taskId}`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // STATE TRANSITIONS
  // --------------------------------------------------------------------------

  /**
   * Create escrow in PENDING state
   */
  create: async (params: CreateEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { taskId, amount } = params;
    
    // Validate amount is positive integer (cents)
    if (!Number.isInteger(amount) || amount <= 0) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Amount must be a positive integer (cents)',
        },
      };
    }
    
    try {
      const result = await db.query<Escrow>(
        `INSERT INTO escrows (task_id, amount, state)
         VALUES ($1, $2, 'PENDING')
         RETURNING *`,
        [taskId, amount]
      );
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          success: false,
          error: {
            code: 'DUPLICATE',
            message: `Escrow already exists for task ${taskId}`,
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Fund escrow: PENDING → FUNDED
   * Called when Stripe payment_intent.succeeded
   */
  fund: async (params: FundEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, stripePaymentIntentId } = params;
    
    try {
      const result = await db.query<Escrow>(
        `UPDATE escrows 
         SET state = 'FUNDED',
             stripe_payment_intent_id = $2,
             funded_at = NOW()
         WHERE id = $1 
           AND state = 'PENDING'
         RETURNING *`,
        [escrowId, stripePaymentIntentId]
      );
      
      if (result.rowCount === 0) {
        // Either not found or wrong state
        const existing = await EscrowService.getById(escrowId);
        if (!existing.success) {
          return existing;
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot fund escrow: current state is ${existing.data.state}, expected PENDING`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Release escrow: FUNDED → RELEASED
   * 
   * INV-2: RELEASED requires COMPLETED task
   * The database trigger enforces this — we catch the error.
   */
  release: async (params: ReleaseEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, stripeTransferId } = params;
    
    try {
      const result = await db.query<Escrow>(
        `UPDATE escrows 
         SET state = 'RELEASED',
             stripe_transfer_id = $2,
             released_at = NOW()
         WHERE id = $1 
           AND state = 'FUNDED'
         RETURNING *`,
        [escrowId, stripeTransferId ?? null]
      );
      
      if (result.rowCount === 0) {
        const existing = await EscrowService.getById(escrowId);
        if (!existing.success) {
          return existing;
        }
        
        if (isTerminalState(existing.data.state)) {
          return {
            success: false,
            error: {
              code: ErrorCodes.ESCROW_TERMINAL,
              message: `Escrow ${escrowId} is in terminal state ${existing.data.state}`,
            },
          };
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot release escrow: current state is ${existing.data.state}, expected FUNDED`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      // Check for INV-2 violation from trigger
      if (isInvariantViolation(error)) {
        const dbError = error as { code: string; message: string };
        if (dbError.code === 'HX201') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INV_2_VIOLATION,
              message: getErrorMessage('HX201'),
              details: { escrowId },
            },
          };
        }
      }
      
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Refund escrow: FUNDED/LOCKED_DISPUTE → REFUNDED
   */
  refund: async (params: RefundEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId } = params;
    
    try {
      const result = await db.query<Escrow>(
        `UPDATE escrows 
         SET state = 'REFUNDED',
             refunded_at = NOW()
         WHERE id = $1 
           AND state IN ('FUNDED', 'LOCKED_DISPUTE')
         RETURNING *`,
        [escrowId]
      );
      
      if (result.rowCount === 0) {
        const existing = await EscrowService.getById(escrowId);
        if (!existing.success) {
          return existing;
        }
        
        if (isTerminalState(existing.data.state)) {
          return {
            success: false,
            error: {
              code: ErrorCodes.ESCROW_TERMINAL,
              message: `Escrow ${escrowId} is in terminal state ${existing.data.state}`,
            },
          };
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot refund escrow: current state is ${existing.data.state}`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Lock for dispute: FUNDED → LOCKED_DISPUTE
   */
  lockForDispute: async (escrowId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>(
        `UPDATE escrows 
         SET state = 'LOCKED_DISPUTE'
         WHERE id = $1 
           AND state = 'FUNDED'
         RETURNING *`,
        [escrowId]
      );
      
      if (result.rowCount === 0) {
        const existing = await EscrowService.getById(escrowId);
        if (!existing.success) {
          return existing;
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot lock escrow: current state is ${existing.data.state}, expected FUNDED`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Partial refund: LOCKED_DISPUTE → REFUND_PARTIAL
   */
  partialRefund: async (params: PartialRefundParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, workerPercent, posterPercent } = params;
    
    // Validate percentages
    if (workerPercent + posterPercent !== 100) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Worker and poster percentages must sum to 100',
        },
      };
    }
    
    try {
      const result = await db.query<Escrow>(
        `UPDATE escrows 
         SET state = 'REFUND_PARTIAL',
             refunded_at = NOW()
         WHERE id = $1 
           AND state = 'LOCKED_DISPUTE'
         RETURNING *`,
        [escrowId]
      );
      
      if (result.rowCount === 0) {
        const existing = await EscrowService.getById(escrowId);
        if (!existing.success) {
          return existing;
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot partially refund: current state is ${existing.data.state}, expected LOCKED_DISPUTE`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  isTerminalState,
  isValidTransition,
  getValidTransitions: (state: EscrowState) => VALID_TRANSITIONS[state] ?? [],
};

export default EscrowService;
