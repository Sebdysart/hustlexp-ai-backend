import crypto from 'node:crypto';

import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { ProofService } from './ProofService.js';
import { TaskCompletionService } from './TaskCompletionService.js';

const CODE_EXPIRY_MINUTES = 30;
const MAX_FAILED_ATTEMPTS = 5;

export interface GenerateCompletionCodeResult { taskId: string; code: string; expiresAt: string; }
export interface VerifyCompletionCodeResult { taskId: string; completed: true; replayed: boolean; }

interface TaskRow { id: string; poster_id: string; state: string; business_fulfiller_organization_id: string | null; completed_at: Date | null; payout_ready_at: Date | null; }
interface ProofRow { id: string; state: string; }
interface VerificationRow { id: string; task_id: string; poster_user_id: string; business_organization_id: string; code_hash: string; expires_at: Date; failed_attempts: number; verified_at: Date | null; }

function failure<T>(code: string, message: string): ServiceResult<T> { return { success: false, error: { code, message } }; }
function secret(): string { const value = process.env.COMPLETION_VERIFICATION_SECRET; if (!value?.trim()) throw new Error('COMPLETION_VERIFICATION_SECRET is required.'); return value; }
function hash(taskId: string, code: string): string { return crypto.createHmac('sha256', secret()).update(`${taskId}:${code}`).digest('hex'); }
function matches(expected: string, actual: string): boolean { try { const a = Buffer.from(expected, 'hex'); const b = Buffer.from(actual, 'hex'); return a.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; } }

async function loadTask(query: QueryFn, taskId: string): Promise<TaskRow | undefined> {
  const result = await query<TaskRow>(`SELECT id, poster_id, state, business_fulfiller_organization_id, completed_at, payout_ready_at FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);
  return result.rows[0];
}

export const CompletionVerificationService = {
  async generateForPoster(taskId: string, posterId: string): Promise<ServiceResult<GenerateCompletionCodeResult>> {
    try {
      return await db.transaction(async (query) => {
        const task = await loadTask(query, taskId);
        if (!task) return failure('TASK_NOT_FOUND', 'Task not found.');
        if (task.poster_id !== posterId) return failure('TASK_POSTER_MISMATCH', 'You are not authorized to access this task.');
        if (task.state === 'COMPLETED') return failure('TASK_ALREADY_COMPLETED', 'This task has already been completed.');
        if (task.state !== 'PROOF_SUBMITTED') return failure('TASK_NOT_READY_FOR_COMPLETION', 'Completion verification is available only after proof has been submitted.');
        if (!task.business_fulfiller_organization_id) return failure('BUSINESS_FULFILLER_MISSING', 'This task is not associated with a fulfilling business.');
        const proof = (await query<ProofRow>(`SELECT id, state FROM proofs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [taskId])).rows[0];
        if (!proof) return failure('PROOF_NOT_FOUND', 'No completion proof exists for this task.');
        if (proof.state !== 'SUBMITTED') return failure('PROOF_NOT_AWAITING_REVIEW', `Latest proof is ${proof.state}, expected SUBMITTED.`);
        const code = crypto.randomInt(100000, 1000000).toString();
        const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);
        const result = await query<{ expires_at: Date }>(`
          INSERT INTO task_completion_verifications (task_id, poster_user_id, business_organization_id, code_hash, expires_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (task_id) DO UPDATE SET poster_user_id = EXCLUDED.poster_user_id, business_organization_id = EXCLUDED.business_organization_id, code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, failed_attempts = 0, verified_at = NULL, verified_by_user_id = NULL, updated_at = NOW()
          RETURNING expires_at`, [taskId, posterId, task.business_fulfiller_organization_id, hash(taskId, code), expiresAt]);
        const stored = result.rows[0];
        if (!stored) return failure('COMPLETION_CODE_CREATE_FAILED', 'Unable to create the completion code.');
        return { success: true, data: { taskId, code, expiresAt: stored.expires_at.toISOString() } };
      });
    } catch { return failure('COMPLETION_CODE_GENERATION_FAILED', 'Unable to generate the completion code.'); }
  },

  async verifyForBusiness(taskId: string, businessUserId: string, code: string): Promise<ServiceResult<VerifyCompletionCodeResult>> {
    try {
      const prepared = await db.transaction(async (query) => {
        const task = await loadTask(query, taskId);
        if (!task) return failure('TASK_NOT_FOUND', 'Task not found.');
        const organizationId = task.business_fulfiller_organization_id;
        if (!organizationId) return failure('BUSINESS_FULFILLER_MISSING', 'This task has no fulfilling business.');
        const member = (await query<{ user_id: string }>(`SELECT user_id FROM business_memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE' LIMIT 1`, [organizationId, businessUserId])).rows[0];
        if (!member) return failure('BUSINESS_NOT_AUTHORIZED', 'You are not authorized to complete this business task.');
        if (task.state === 'COMPLETED' && task.completed_at && task.payout_ready_at) return { success: true as const, data: { posterId: task.poster_id, proofId: '', replayedVerification: true, alreadyCompleted: true } };
        if (task.state !== 'PROOF_SUBMITTED') return failure('TASK_NOT_READY_FOR_COMPLETION', 'This task is not awaiting completion verification.');
        const proof = (await query<ProofRow>(`SELECT id, state FROM proofs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [taskId])).rows[0];
        if (!proof) return failure('PROOF_NOT_FOUND', 'No completion proof exists for this task.');
        if (!['SUBMITTED', 'ACCEPTED'].includes(proof.state)) return failure('PROOF_NOT_COMPLETABLE', `Latest proof is ${proof.state} and cannot be completed.`);
        const verification = (await query<VerificationRow>(`SELECT id, task_id, poster_user_id, business_organization_id, code_hash, expires_at, failed_attempts, verified_at FROM task_completion_verifications WHERE task_id = $1 FOR UPDATE`, [taskId])).rows[0];
        if (!verification) return failure('COMPLETION_CODE_NOT_CREATED', 'The customer has not generated a completion code yet.');
        if (verification.business_organization_id !== organizationId) return failure('COMPLETION_BUSINESS_MISMATCH', 'The completion code does not belong to this business task.');
        if (verification.poster_user_id !== task.poster_id) return failure('COMPLETION_POSTER_MISMATCH', 'The completion code does not belong to this task poster.');
        if (verification.verified_at) return { success: true as const, data: { posterId: task.poster_id, proofId: proof.id, replayedVerification: true, alreadyCompleted: false } };
        if (verification.expires_at <= new Date()) return failure('COMPLETION_CODE_EXPIRED', 'This completion code has expired. Ask the customer to generate a new one.');
        if (verification.failed_attempts >= MAX_FAILED_ATTEMPTS) return failure('COMPLETION_CODE_LOCKED', 'Too many incorrect attempts. Ask the customer to generate a new completion code.');
        if (!matches(verification.code_hash, hash(taskId, code))) {
          const attempts = verification.failed_attempts + 1;
          await query(`UPDATE task_completion_verifications SET failed_attempts = $2, updated_at = NOW() WHERE id = $1`, [verification.id, attempts]);
          return failure(attempts >= MAX_FAILED_ATTEMPTS ? 'COMPLETION_CODE_LOCKED' : 'COMPLETION_CODE_INVALID', attempts >= MAX_FAILED_ATTEMPTS ? 'Too many incorrect attempts. Ask the customer to generate a new completion code.' : 'The completion code is incorrect.');
        }
        await query(`UPDATE task_completion_verifications SET verified_at = NOW(), verified_by_user_id = $2, updated_at = NOW() WHERE id = $1`, [verification.id, businessUserId]);
        return { success: true as const, data: { posterId: task.poster_id, proofId: proof.id, replayedVerification: false, alreadyCompleted: false } };
      });
      if (!prepared.success) return prepared;
      const preparedData = prepared.data as { posterId: string; proofId: string; replayedVerification: boolean; alreadyCompleted: boolean };
      if (preparedData.alreadyCompleted) return { success: true, data: { taskId, completed: true, replayed: true } };
      if (preparedData.proofId) {
        const proof = (await db.query<{ state: string }>(`SELECT state FROM proofs WHERE id = $1`, [preparedData.proofId])).rows[0];
        if (proof?.state === 'SUBMITTED') {
          const reviewed = await ProofService.review({ proofId: preparedData.proofId, reviewerId: preparedData.posterId, decision: 'ACCEPTED', reason: 'Poster confirmed completion by sharing the completion verification code.' });
          if (!reviewed.success) return reviewed;
        }
      }
      const completed = await TaskCompletionService.complete(taskId, preparedData.posterId, { mode: 'POSTER_CONFIRMED', actorId: businessUserId });
      if (!completed.success) return completed;
      return { success: true, data: { taskId, completed: true, replayed: preparedData.replayedVerification } };
    } catch { return failure('COMPLETION_VERIFICATION_FAILED', 'Unable to verify the completion code.'); }
  },
};
