import { TRPCError } from '@trpc/server';
import {
  db,
  getErrorMessage,
  isInvariantViolation,
  type QueryFn,
} from '../db.js';
import type { Proof, ServiceResult } from '../types.js';
import {
  assertDurablePhotoEvidence,
  proofSubmissionHash,
} from './ProofPolicy.js';
import type { SubmitProofParams } from './ProofTypes.js';
import { consumeFinalizedMediaReceipt } from './MediaUploadReceiptService.js';

interface ProofTaskRow {
  worker_id: string | null;
  state: string;
  active_scope_version_id: string | null;
  scope_hash: string | null;
  scope_change_pending: boolean;
  checklist_count: number;
  completed_count: number;
  proof_min_photos: number | null;
  proof_max_photos: number | null;
  proof_gps_required: boolean;
  version: number;
}

function hasOfflineSyncEvidence(params: SubmitProofParams): boolean {
  return params.clientSequence !== undefined
    && params.priorTaskVersion !== undefined
    && params.localOccurredAt !== undefined
    && params.deviceVersion !== undefined
    && params.appVersion !== undefined;
}

function assertSubmissionContent(params: SubmitProofParams): void {
  const hasDescription = typeof params.description === 'string' && params.description.trim().length > 0;
  const hasPhotos = Array.isArray(params.photoEvidence) && params.photoEvidence.length > 0;
  const hasLocation = params.gpsLatitude != null && params.gpsLongitude != null;
  if (!hasDescription && !hasPhotos && !hasLocation) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Proof must include at least a description, photo, or location.',
    });
  }
}

function assertGpsEvidence(params: SubmitProofParams): void {
  const provided = [params.gpsLatitude, params.gpsLongitude, params.gpsAccuracyMeters]
    .filter((value) => value != null).length;
  if (provided === 0) return;
  if (provided !== 3) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'GPS proof requires latitude, longitude, and measured accuracy together.',
    });
  }
  if (!Number.isFinite(params.gpsLatitude)
      || params.gpsLatitude! < -90
      || params.gpsLatitude! > 90
      || !Number.isFinite(params.gpsLongitude)
      || params.gpsLongitude! < -180
      || params.gpsLongitude! > 180
      || !Number.isFinite(params.gpsAccuracyMeters)
      || params.gpsAccuracyMeters! < 0
      || params.gpsAccuracyMeters! > 10_000) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'GPS proof metadata is invalid.' });
  }
}

async function lockTask(query: QueryFn, taskId: string): Promise<ProofTaskRow> {
  const result = await query<ProofTaskRow>(
    `SELECT t.worker_id, t.state, t.active_scope_version_id, t.scope_hash, t.version,
            t.proof_min_photos, t.proof_max_photos, t.proof_gps_required,
            EXISTS (
              SELECT 1 FROM task_scope_change_proposals p
              WHERE p.task_id = t.id AND p.status = 'PENDING'
            ) AS scope_change_pending,
            COALESCE(jsonb_array_length(v.checklist), 0) AS checklist_count,
            (SELECT COUNT(*)::int FROM task_scope_checklist_progress cp
             WHERE cp.version_id = t.active_scope_version_id) AS completed_count
     FROM tasks t
     LEFT JOIN task_scope_versions v ON v.id = t.active_scope_version_id
     WHERE t.id = $1 FOR UPDATE OF t`,
    [taskId],
  );
  if (!result.rows[0]) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Task ${taskId} not found` });
  }
  return result.rows[0];
}

function assertTaskEvidencePolicy(task: ProofTaskRow, params: SubmitProofParams): void {
  const photoCount = params.photoEvidence?.length ?? 0;
  const minimumPhotos = Number(task.proof_min_photos ?? 0);
  const maximumPhotos = Number(task.proof_max_photos ?? 10);
  if (!Number.isInteger(minimumPhotos) || minimumPhotos < 0
      || !Number.isInteger(maximumPhotos) || maximumPhotos < minimumPhotos) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The task proof policy is invalid. Contact support before submitting evidence.',
    });
  }
  if (photoCount < minimumPhotos) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `This task requires at least ${minimumPhotos} proof photo${minimumPhotos === 1 ? '' : 's'}.`,
    });
  }
  if (photoCount > maximumPhotos) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This task allows at most ${maximumPhotos} proof photo${maximumPhotos === 1 ? '' : 's'}.`,
    });
  }
  if (task.proof_gps_required
      && (params.gpsLatitude == null
        || params.gpsLongitude == null
        || params.gpsAccuracyMeters == null)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This task requires measured GPS proof with latitude, longitude, and accuracy.',
    });
  }
}

function assertSubmitter(task: ProofTaskRow, params: SubmitProofParams): void {
  if (task.worker_id !== params.submitterId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Only the assigned worker can submit proof.' });
  }
}

function assertTaskReady(task: ProofTaskRow, params: SubmitProofParams): void {
  if (task.state !== 'ACCEPTED') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Cannot submit proof for a task in '${task.state}' state.`,
    });
  }
  if (task.scope_change_pending) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Execution is frozen until the pending scope change is decided.',
    });
  }
  if (!task.active_scope_version_id) return;
  if (params.scopeVersionId !== task.active_scope_version_id || params.scopeHash !== task.scope_hash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Proof must bind to the current approved execution scope.',
    });
  }
  if (Number(task.completed_count) !== Number(task.checklist_count)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Complete every approved checklist item before submitting proof.',
    });
  }
}

async function replayedProof(
  query: QueryFn,
  params: SubmitProofParams,
  submissionHash: string | null,
): Promise<Proof | null> {
  if (!params.clientSubmissionId || !submissionHash) return null;
  const replay = await query<Proof & {
    submission_hash: string;
    submitter_id: string;
    sync_contract_version: number;
    reconciliation_contract_version: number;
  }>(
    `SELECT * FROM proofs
     WHERE task_id = $1 AND client_submission_id = $2
     LIMIT 1`,
    [params.taskId, params.clientSubmissionId],
  );
  if (!replay.rows[0]) return null;
  const expectedHash = Number(replay.rows[0].sync_contract_version) === 1
    ? proofSubmissionHash({
      ...params,
      offlinePayloadHash: Number(replay.rows[0].reconciliation_contract_version) === 1
        ? params.offlinePayloadHash
        : undefined,
    })
    : proofSubmissionHash(params, false);
  if (replay.rows[0].submitter_id !== params.submitterId
      || replay.rows[0].submission_hash !== expectedHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Proof submission key was already used with different evidence.',
    });
  }
  return { ...replay.rows[0], idempotency_replayed: true };
}

async function assertOfflineSyncOrder(
  query: QueryFn,
  task: ProofTaskRow,
  params: SubmitProofParams,
): Promise<void> {
  if (!hasOfflineSyncEvidence(params)) return;
  if (params.priorTaskVersion !== Number(task.version)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'OFFLINE_SYNC_STALE_TASK_VERSION: refresh the task before submitting proof.',
    });
  }
  const last = await query<{ client_sequence: string | number | null }>(
    `SELECT MAX(client_sequence) AS client_sequence
       FROM proofs
      WHERE task_id=$1 AND submitter_id=$2 AND sync_contract_version=1`,
    [params.taskId, params.submitterId],
  );
  if (Number(params.clientSequence) <= Number(last.rows[0]?.client_sequence ?? 0)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'OFFLINE_SYNC_STALE_SEQUENCE: a newer proof command was already accepted.',
    });
  }
}

async function assertNoActiveProof(query: QueryFn, taskId: string): Promise<void> {
  const existing = await query(
    `SELECT id FROM proofs
     WHERE task_id = $1 AND state IN ('pending', 'submitted', 'PENDING', 'SUBMITTED')
     FOR UPDATE`,
    [taskId],
  );
  if (existing.rows.length > 0) {
    throw new TRPCError({ code: 'CONFLICT', message: 'A proof is already pending review for this task.' });
  }
}

async function insertProof(
  query: QueryFn,
  params: SubmitProofParams,
  task: ProofTaskRow,
  submissionHash: string | null,
): Promise<Proof> {
  const result = await query<Proof>(
    `INSERT INTO proofs (
       task_id, submitter_id, state, description,
       scope_version_id, scope_version_hash,
       client_submission_id, submission_hash,
       sync_contract_version,client_sequence,prior_task_version,local_occurred_at,
       device_version,app_version,entry_surface,context_source,intended_transition,
       reconciliation_contract_version,offline_payload_hash
     ) VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7,
       $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      params.taskId,
      params.submitterId,
      params.description,
      task.active_scope_version_id ?? null,
      task.scope_hash ?? null,
      params.clientSubmissionId ?? null,
      submissionHash,
      hasOfflineSyncEvidence(params) ? 1 : 0,
      params.clientSequence ?? null,
      params.priorTaskVersion ?? null,
      params.localOccurredAt ?? null,
      params.deviceVersion ?? null,
      params.appVersion ?? null,
      hasOfflineSyncEvidence(params) ? 'TASK_PROOF_COMPOSER' : null,
      hasOfflineSyncEvidence(params) ? 'ACTIVE_TASK' : null,
      hasOfflineSyncEvidence(params) ? 'ACCEPTED_TO_PROOF_SUBMITTED' : null,
      params.offlinePayloadHash ? 1 : 0,
      params.offlinePayloadHash ?? null,
    ],
  );
  return result.rows[0];
}

async function insertProofPhotos(query: QueryFn, proofId: string, params: SubmitProofParams): Promise<void> {
  for (const [index, photo] of (params.photoEvidence ?? []).entries()) {
    const finalized = await consumeFinalizedMediaReceipt(query, {
      evidence: photo,
      taskId: params.taskId,
      uploaderId: params.submitterId,
      purpose: 'PROOF',
      consumerId: proofId,
    });
    await query(
      `INSERT INTO proof_photos (
         proof_id, storage_key, content_type, file_size_bytes,
         checksum_sha256, capture_time, sequence_number
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        proofId,
        finalized.storageKey,
        finalized.contentType,
        finalized.fileSizeBytes,
        finalized.checksumSha256,
        photo.capturedAt ?? null,
        index + 1,
      ],
    );
  }
}

async function insertVerificationEvidence(query: QueryFn, proofId: string, params: SubmitProofParams): Promise<void> {
  const coordinates = params.gpsLatitude == null || params.gpsLongitude == null
    ? null
    : JSON.stringify({ latitude: params.gpsLatitude, longitude: params.gpsLongitude });
  await query(
    `INSERT INTO proof_submissions (
       proof_id, user_id, gps_coordinates, gps_accuracy_meters
     ) VALUES ($1, $2, $3::jsonb, $4)`,
    [
      proofId,
      params.submitterId,
      coordinates,
      params.gpsAccuracyMeters ?? null,
    ],
  );
}

async function submitTransaction(
  query: QueryFn,
  params: SubmitProofParams,
  submissionHash: string | null,
): Promise<Proof> {
  const task = await lockTask(query, params.taskId);
  assertSubmitter(task, params);
  const replay = await replayedProof(query, params, submissionHash);
  if (replay) return replay;
  await assertOfflineSyncOrder(query, task, params);
  assertTaskReady(task, params);
  assertTaskEvidencePolicy(task, params);
  await assertNoActiveProof(query, params.taskId);
  const proof = await insertProof(query, params, task, submissionHash);
  await insertProofPhotos(query, proof.id, params);
  await insertVerificationEvidence(query, proof.id, params);
  const submitted = await query<Proof>(
    `UPDATE proofs SET state = 'SUBMITTED', submitted_at = NOW() WHERE id = $1 RETURNING *`,
    [proof.id],
  );
  return submitted.rows[0];
}

function submissionFailure(error: unknown): ServiceResult<Proof> {
  if (error instanceof TRPCError) throw error;
  if (isInvariantViolation(error)) {
    const code = error.code || 'INVARIANT_VIOLATION';
    return { success: false, error: { code, message: getErrorMessage(code) } };
  }
  return {
    success: false,
    error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
  };
}

export async function submitProof(
  params: SubmitProofParams,
  transactionQuery?: QueryFn,
): Promise<ServiceResult<Proof>> {
  try {
    assertDurablePhotoEvidence(params);
    assertGpsEvidence(params);
    assertSubmissionContent(params);
    const hash = proofSubmissionHash(params);
    const submitted = transactionQuery
      ? await submitTransaction(transactionQuery, params, hash)
      : await db.transaction((query) => submitTransaction(query, params, hash));
    return { success: true, data: submitted };
  } catch (error) {
    return submissionFailure(error);
  }
}
