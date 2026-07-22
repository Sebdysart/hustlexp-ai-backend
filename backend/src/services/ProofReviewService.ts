import { TRPCError } from '@trpc/server';
import { db, getErrorMessage, isInvariantViolation } from '../db.js';
import type { Proof, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { isValidProofTransition } from './ProofPolicy.js';
import {
  acquireProofReviewLock,
  releaseProofReviewLock,
} from './ProofReviewLock.js';
import type { ProofWithSignals, ReviewProofParams } from './ProofTypes.js';
import { JudgeAIService, type JudgeVerdict } from './JudgeAIService.js';
import { verifyAcceptedProof } from './ProofVerificationPipeline.js';
import {
  issueSingleParticipantMediaAccess,
  type DeliveryDependencies,
} from './PrivateMediaDeliveryService.js';

type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ProofReviewDependencies = Pick<DeliveryDependencies, 'signObject' | 'now'>;

async function loadReviewProof(proofId: string): Promise<ProofWithSignals | null> {
  const result = await db.query<ProofWithSignals>(
    `SELECT p.*, pp.storage_key AS photo_url,
            ps.gps_coordinates, ps.gps_accuracy_meters,
            NULL::TEXT AS lidar_depth_map_url
     FROM proofs p
     LEFT JOIN LATERAL (
       SELECT gps_coordinates, gps_accuracy_meters
       FROM proof_submissions WHERE proof_id = p.id
       ORDER BY created_at DESC, id DESC LIMIT 1
     ) ps ON TRUE
     LEFT JOIN LATERAL (
       SELECT storage_key FROM proof_photos WHERE proof_id = p.id
       ORDER BY sequence_number ASC, created_at ASC, id ASC LIMIT 1
     ) pp ON TRUE
     WHERE p.id = $1
     LIMIT 1`,
    [proofId],
  );
  return result.rows[0] ?? null;
}

function initialReviewFailure(
  proof: ProofWithSignals | null,
  params: ReviewProofParams,
): ServiceResult<Proof> | null {
  if (!proof) {
    return {
      success: false,
      error: { code: ErrorCodes.NOT_FOUND, message: `Proof ${params.proofId} not found` },
    };
  }
  if (!isValidProofTransition(proof.state, params.decision)) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_TRANSITION,
        message: `Cannot transition proof from ${proof.state} to ${params.decision}`,
      },
    };
  }
  return null;
}

async function assertPosterReviewer(proof: ProofWithSignals, reviewerId: string): Promise<ServiceResult<Proof> | null> {
  const result = await db.query<{ poster_id: string }>(
    `SELECT poster_id FROM tasks WHERE id = $1`,
    [proof.task_id],
  );
  if (result.rows.length > 0 && result.rows[0].poster_id === reviewerId) return null;
  return {
    success: false,
    error: { code: ErrorCodes.FORBIDDEN, message: 'Not authorized to review this proof' },
  };
}

async function attachPrivateReviewMedia(
  proof: ProofWithSignals,
  reviewerId: string,
  dependencies: ProofReviewDependencies,
): Promise<ProofWithSignals> {
  if (!proof.photo_url) return proof;
  if (/^https?:\/\//i.test(proof.photo_url)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Proof approval is blocked until legacy public media is replaced by private receipt-backed evidence.',
    });
  }
  const access = await issueSingleParticipantMediaAccess({
    taskId: proof.task_id,
    viewerId: reviewerId,
    purpose: 'PROOF',
    accessReason: 'PROOF_REVIEW',
    consumerId: proof.id,
    storageKey: proof.photo_url,
  }, dependencies);
  if (!access) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Private proof media is unavailable. Approval remains blocked; reload and retry.',
    });
  }
  return { ...proof, photo_url: access.downloadUrl };
}

async function lockProofForReview(query: Query, proofId: string): Promise<string> {
  const result = await query<{ state: string; task_id: string }>(
    `SELECT state, task_id FROM proofs WHERE id = $1 FOR UPDATE`,
    [proofId],
  );
  if (!result.rows[0]) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Proof ${proofId} not found` });
  }
  if (result.rows[0].state !== 'SUBMITTED') {
    throw new TRPCError({ code: 'CONFLICT', message: 'Proof already reviewed' });
  }
  return result.rows[0].task_id;
}

async function assertTaskReviewState(query: Query, taskId: string): Promise<void> {
  const result = await query<{ state: string }>(
    'SELECT state FROM tasks WHERE id = $1 FOR UPDATE',
    [taskId],
  );
  if (result.rows[0]?.state === 'PROOF_SUBMITTED') return;
  throw new TRPCError({
    code: 'CONFLICT',
    message: `TASK_STATE_CHANGED:Task is no longer in PROOF_SUBMITTED state (current: ${result.rows[0]?.state ?? 'unknown'})`,
  });
}

async function commitReview(
  query: Query,
  params: ReviewProofParams,
  judgeVerdict: JudgeVerdict | null,
): Promise<Proof> {
  const taskId = await lockProofForReview(query, params.proofId);
  await assertTaskReviewState(query, taskId);
  if (judgeVerdict) {
    const audit = await JudgeAIService.logVerdict(
      params.proofId,
      taskId,
      judgeVerdict,
      query,
      {
        validatorOverride: judgeVerdict.verdict === 'MANUAL_REVIEW',
        validatorReason: judgeVerdict.verdict === 'MANUAL_REVIEW'
          ? (params.reason ?? 'Human reviewer accepted a MANUAL_REVIEW verdict')
          : null,
      },
    );
    if (!audit.success) {
      throw new Error(`JUDGE_AUDIT_FAILED:${audit.error.message}`);
    }
  }
  const result = await query<Proof>(
    `UPDATE proofs
     SET state = $1, reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3
     WHERE id = $4 AND state = 'SUBMITTED'
     RETURNING *`,
    [params.decision, params.reviewerId, params.reason, params.proofId],
  );
  if (result.rowCount === 0) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Proof already reviewed' });
  }
  return result.rows[0];
}

function reviewFailure(error: unknown): ServiceResult<Proof> {
  if (error instanceof TRPCError) throw error;
  if (isInvariantViolation(error)) {
    const code = error.code || 'INVARIANT_VIOLATION';
    return { success: false, error: { code, message: getErrorMessage(code) } };
  }
  if (error instanceof Error && error.message.startsWith('JUDGE_AUDIT_FAILED:')) {
    return {
      success: false,
      error: {
        code: 'JUDGE_AUDIT_FAILED',
        message: 'Proof acceptance was rolled back because its verification audit could not be stored.',
      },
    };
  }
  return {
    success: false,
    error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
  };
}

async function reviewWithAdvisoryLock(
  proof: ProofWithSignals,
  params: ReviewProofParams,
): Promise<ServiceResult<Proof>> {
  const acquired = await acquireProofReviewLock(params.proofId);
  if (!acquired) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Another reviewer is already processing this proof. Please try again shortly.',
    });
  }
  try {
    let judgeVerdict: JudgeVerdict | null = null;
    if (params.decision === 'ACCEPTED') {
      const verification = await verifyAcceptedProof(params.proofId, params.reviewerId, proof);
      if (verification.failure) {
        if (verification.verdict) {
          const audit = await JudgeAIService.logVerdict(params.proofId, proof.task_id, verification.verdict);
          if (!audit.success) {
            return {
              success: false,
              error: {
                code: 'JUDGE_AUDIT_FAILED',
                message: 'The verification decision could not be stored safely.',
              },
            };
          }
        }
        return verification.failure;
      }
      judgeVerdict = verification.verdict;
    }
    const updated = await db.transaction((query) => commitReview(query, params, judgeVerdict));
    return { success: true, data: updated };
  } finally {
    await releaseProofReviewLock(params.proofId);
  }
}

export async function reviewProof(
  params: ReviewProofParams,
  dependencies: ProofReviewDependencies = {},
): Promise<ServiceResult<Proof>> {
  try {
    const proof = await loadReviewProof(params.proofId);
    const validation = initialReviewFailure(proof, params);
    if (validation) return validation;
    const authorization = await assertPosterReviewer(proof!, params.reviewerId);
    if (authorization) return authorization;
    const reviewProof = await attachPrivateReviewMedia(proof!, params.reviewerId, dependencies);
    return await reviewWithAdvisoryLock(reviewProof, params);
  } catch (error) {
    return reviewFailure(error);
  }
}
