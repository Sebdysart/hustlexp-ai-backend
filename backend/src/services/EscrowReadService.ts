import { db, isUniqueViolation } from '../db.js';
import type { QueryFn } from '../db.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { escrowLogger } from '../logger.js';
import type { CreateEscrowParams } from './EscrowServiceShared.js';

export const getEscrowById = async (escrowId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>(
        `SELECT e.*, t.poster_id, t.worker_id
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.id = $1`,
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  };

export const getEscrowByTaskId = async (taskId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>(
        `SELECT e.*, t.poster_id, t.worker_id
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.task_id = $1`,
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  };

export const createEscrow = async (params: CreateEscrowParams): Promise<ServiceResult<Escrow>> => {
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  };

export const syncPendingEscrowAmount = async (
    taskId: string,
    newAmountCents: number,
    q?: QueryFn
  ): Promise<ServiceResult<{ updated: boolean }>> => {
    if (!Number.isInteger(newAmountCents) || newAmountCents <= 0) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Escrow amount must be a positive integer (cents)',
        },
      };
    }
    const exec: QueryFn = q ?? db.query;
    const result = await exec(
      `UPDATE escrows SET amount = $1 WHERE task_id = $2 AND state = 'PENDING'`,
      [newAmountCents, taskId]
    );
    return { success: true, data: { updated: (result.rowCount ?? 0) > 0 } };
  };
