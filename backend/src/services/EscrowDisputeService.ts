import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { escrowLogger } from '../logger.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { getEscrowById } from './EscrowReadService.js';
import { logEscrowEvent } from './EscrowServiceShared.js';

interface DisputeLockRow {
  completed_at: Date | null;
  challenge_window_hours: number | null;
  version: number;
  state: string;
  task_state: string;
}

interface DisputeLockOptions {
  adminOverride?: boolean;
  initiatedBy?: string;
  allowedTaskStates?: string[];
}

function trpcError(code: 'CONFLICT' | 'TOO_MANY_REQUESTS' | 'PRECONDITION_FAILED', message: string): never {
  throw new TRPCError({ code, message });
}

async function loadLockRow(query: QueryFn, escrowId: string): Promise<DisputeLockRow | null> {
  const result = await query<DisputeLockRow>(
    `SELECT t.completed_at, t.challenge_window_hours, e.version, e.state, t.state AS task_state
       FROM escrows e
       JOIN tasks t ON t.id = e.task_id
      WHERE e.id = $1
      FOR UPDATE OF e`,
    [escrowId],
  );
  return result.rows[0] ?? null;
}

async function assertNoOpenDispute(query: QueryFn, escrowId: string): Promise<void> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM disputes WHERE escrow_id = $1 AND state != 'RESOLVED'`,
    [escrowId],
  );
  if (Number.parseInt(result.rows[0]?.count ?? '0', 10) > 0) {
    trpcError('CONFLICT', 'Dispute already open for this escrow');
  }
}

async function assertDisputeRate(query: QueryFn, initiatedBy?: string): Promise<void> {
  if (!initiatedBy) return;
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM disputes
      WHERE initiated_by = $1
        AND state != 'RESOLVED'
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [initiatedBy],
  );
  if (Number.parseInt(result.rows[0]?.count ?? '0', 10) >= 3) {
    trpcError('TOO_MANY_REQUESTS', 'Dispute rate limit exceeded: maximum 3 open disputes per 24 hours');
  }
}

function assertTaskState(row: DisputeLockRow | null, options: DisputeLockOptions): void {
  if (!options.allowedTaskStates || options.adminOverride) return;
  if (!row?.task_state || !options.allowedTaskStates.includes(row.task_state)) {
    trpcError(
      'PRECONDITION_FAILED',
      'Can only file a dispute on an active task (accepted, in-progress, proof-submitted, or completed)',
    );
  }
}

function assertChallengeWindow(row: DisputeLockRow | null): void {
  if (!row?.completed_at) return;
  const hours = row.challenge_window_hours ?? 6;
  const deadline = new Date(row.completed_at).getTime() + hours * 60 * 60 * 1000;
  if (Date.now() > deadline) {
    trpcError(
      'PRECONDITION_FAILED',
      `Dispute window has closed. Tasks must be disputed within ${hours} hours of completion.`,
    );
  }
}

async function transitionToDispute(
  query: QueryFn,
  escrowId: string,
  row: DisputeLockRow | null,
): Promise<ServiceResult<Escrow>> {
  const result = await query<Escrow>(
    `UPDATE escrows
        SET state = 'LOCKED_DISPUTE',
            stripe_transfer_id = CASE WHEN state = 'RELEASED' THEN NULL ELSE stripe_transfer_id END,
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1
        AND state IN ('FUNDED', 'RELEASED')
        AND version = $2
      RETURNING *`,
    [escrowId, row?.version],
  );
  if ((result.rowCount ?? 0) > 0) {
    await logEscrowEvent(escrowId, row?.state ?? 'FUNDED', 'LOCKED_DISPUTE');
    return { success: true, data: result.rows[0] };
  }
  const existing = await getEscrowById(escrowId);
  if (!existing.success) return existing;
  return {
    success: false,
    error: {
      code: ErrorCodes.INVALID_STATE,
      message: `Cannot lock escrow: current state is ${existing.data.state}, expected FUNDED or RELEASED`,
    },
  };
}

async function executeDisputeLock(
  query: QueryFn,
  escrowId: string,
  options: DisputeLockOptions,
): Promise<ServiceResult<Escrow>> {
  const row = await loadLockRow(query, escrowId);
  await assertNoOpenDispute(query, escrowId);
  await assertDisputeRate(query, options.initiatedBy);
  assertTaskState(row, options);
  assertChallengeWindow(row);
  return transitionToDispute(query, escrowId, row);
}

export async function lockEscrowForDispute(
  escrowId: string,
  options: DisputeLockOptions = {},
): Promise<ServiceResult<Escrow>> {
  try {
    return await db.transaction((query) => executeDisputeLock(query, escrowId, options));
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    escrowLogger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'EscrowService DB error',
    );
    return {
      success: false,
      error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
    };
  }
}
