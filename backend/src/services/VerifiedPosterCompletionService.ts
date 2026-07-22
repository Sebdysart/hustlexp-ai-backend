import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { taskLogger } from '../logger.js';
import type { ServiceResult, Task } from '../types.js';
import { ErrorCodes } from '../types.js';
import { ProofService } from './ProofService.js';
import { TaskCompletionService } from './TaskCompletionService.js';

const log = taskLogger.child({ service: 'VerifiedPosterCompletionService' });

export interface VerifiedPosterCompletionParams {
  taskId: string;
  providerConfirmationId: string;
  score?: 4 | 5;
  actorId: string;
  channel?: 'SMS' | 'WEB';
  expectedPosterId?: string;
}

interface CompletionContext {
  state: string;
  poster_id: string;
  payout_ready_at: Date | null;
}

function failure<T>(code: string, message: string): ServiceResult<T> {
  return { success: false, error: { code, message } };
}

async function context(taskId: string): Promise<ServiceResult<CompletionContext>> {
  const task = await db.query<CompletionContext>(
    'SELECT state, poster_id, payout_ready_at FROM tasks WHERE id = $1',
    [taskId],
  );
  return task.rows[0]
    ? { success: true, data: task.rows[0] }
    : failure(ErrorCodes.NOT_FOUND, `Task ${taskId} not found`);
}

async function acceptLatestProof(
  taskId: string,
  posterId: string,
  channel: 'SMS' | 'WEB' = 'SMS',
): Promise<ServiceResult<true>> {
  const proof = await db.query<{ id: string; state: string }>(
    'SELECT id, state FROM proofs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
    [taskId],
  );
  const latest = proof.rows[0];
  if (!latest) return failure(ErrorCodes.NOT_FOUND, 'No completion proof exists for this task');
  if (latest.state === 'ACCEPTED') return { success: true, data: true };
  if (latest.state !== 'SUBMITTED') {
    return failure(ErrorCodes.INVALID_STATE, `Latest proof is ${latest.state}, expected SUBMITTED`);
  }
  try {
    const reviewed = await ProofService.review({
      proofId: latest.id,
      reviewerId: posterId,
      decision: 'ACCEPTED',
      reason: channel === 'WEB'
        ? 'Poster confirmed completion through authenticated self-service'
        : 'Poster confirmed completion through a verified messaging channel',
    });
    return reviewed.success ? { success: true, data: true } : reviewed;
  } catch (error) {
    if (!(error instanceof TRPCError) || error.code !== 'CONFLICT') throw error;
    const raced = await db.query<{ state: string }>('SELECT state FROM proofs WHERE id = $1', [latest.id]);
    return raced.rows[0]?.state === 'ACCEPTED'
      ? { success: true, data: true }
      : failure(ErrorCodes.INVALID_STATE, 'Proof review changed concurrently without being accepted');
  }
}

async function writeEvidence(params: VerifiedPosterCompletionParams): Promise<boolean> {
  const key = `poster-confirmed:${params.providerConfirmationId}`;
  const existing = await db.query<{ task_id: string }>(
    'SELECT task_id FROM engine_automation_events WHERE idempotency_key = $1',
    [key],
  );
  if (existing.rows[0] && existing.rows[0].task_id !== params.taskId) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Provider confirmation belongs to another task' });
  }
  if (existing.rows[0]) return true;
  await db.query(
    `INSERT INTO engine_automation_events (task_id, event_type, idempotency_key, payload)
     VALUES ($1, 'POSTER_CONFIRMED_COMPLETION', $2, $3::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [params.taskId, key, JSON.stringify({
      providerConfirmationId: params.providerConfirmationId,
      score: params.score,
      channel: params.channel ?? 'SMS',
      actorId: params.actorId,
    })],
  );
  return false;
}

async function replayCompleted(params: VerifiedPosterCompletionParams): Promise<ServiceResult<Task>> {
  const task = await db.query<Task>('SELECT * FROM tasks WHERE id = $1', [params.taskId]);
  await writeEvidence(params);
  return { success: true, data: { ...task.rows[0], completion_idempotency_replayed: true } };
}

async function completeConfirmed(
  params: VerifiedPosterCompletionParams,
  posterId: string,
): Promise<ServiceResult<Task>> {
  const accepted = await acceptLatestProof(params.taskId, posterId, params.channel);
  if (!accepted.success) return accepted;
  const completed = await TaskCompletionService.complete(params.taskId, posterId, {
    mode: 'POSTER_CONFIRMED', actorId: params.actorId,
  });
  if (!completed.success) return completed;
  const evidenceReplayed = await writeEvidence(params);
  return {
    success: true,
    data: {
      ...completed.data,
      completion_idempotency_replayed:
        completed.data.completion_idempotency_replayed === true || evidenceReplayed,
    },
  };
}

async function confirmLoaded(
  params: VerifiedPosterCompletionParams,
  loaded: CompletionContext,
): Promise<ServiceResult<Task>> {
  if (params.expectedPosterId && loaded.poster_id !== params.expectedPosterId) {
    return failure(ErrorCodes.FORBIDDEN, 'Only the task poster can confirm completion');
  }
  if (loaded.state === 'COMPLETED' && loaded.payout_ready_at) {
    return await replayCompleted(params);
  }
  if (loaded.state !== 'PROOF_SUBMITTED') {
    return failure(ErrorCodes.INVALID_STATE, `Cannot confirm completion from ${loaded.state}`);
  }
  return await completeConfirmed(params, loaded.poster_id);
}

async function confirm(params: VerifiedPosterCompletionParams): Promise<ServiceResult<Task>> {
  try {
    const loaded = await context(params.taskId);
    if (!loaded.success) return loaded;
    return await confirmLoaded(params, loaded.data);
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'CONFLICT') {
      return failure('IDEMPOTENCY_CONFLICT', error.message);
    }
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'Verified poster completion failed');
    return failure('DB_ERROR', 'A database error occurred. Please try again.');
  }
}

export const VerifiedPosterCompletionService = { confirm };
