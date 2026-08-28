import { db } from '../db.js';
import type { ServiceResult, Proof, ProofPhoto, ProofVideo } from '../types.js';
import { ErrorCodes } from '../types.js';
import type { AddPhotoParams, AddVideoParams } from './ProofTypes.js';

function databaseFailure<T>(error: unknown): ServiceResult<T> {
  return {
    success: false,
    error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
  };
}

export async function getProofById(proofId: string): Promise<ServiceResult<Proof>> {
  try {
    const result = await db.query<Proof>('SELECT * FROM proofs WHERE id = $1', [proofId]);
    if (result.rows.length === 0) {
      return {
        success: false,
        error: { code: ErrorCodes.NOT_FOUND, message: `Proof ${proofId} not found` },
      };
    }
    return { success: true, data: result.rows[0] };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getProofByTaskId(taskId: string): Promise<ServiceResult<Proof | null>> {
  try {
    const result = await db.query<Proof>(
      'SELECT * FROM proofs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
      [taskId],
    );
    return { success: true, data: result.rows[0] || null };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getProofPhotos(proofId: string): Promise<ServiceResult<ProofPhoto[]>> {
  try {
    const result = await db.query<ProofPhoto>(
      'SELECT * FROM proof_photos WHERE proof_id = $1 ORDER BY sequence_number',
      [proofId],
    );
    return { success: true, data: result.rows };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getProofVideos(proofId: string): Promise<ServiceResult<ProofVideo[]>> {
  try {
    const result = await db.query<ProofVideo>(
      'SELECT * FROM proof_videos WHERE proof_id = $1 ORDER BY sequence_number',
      [proofId],
    );
    return { success: true, data: result.rows };
  } catch (error) {
    return databaseFailure(error);
  }
}

async function insertPhoto(query: Parameters<Parameters<typeof db.transaction>[0]>[0], params: AddPhotoParams) {
  let sequence = params.sequenceNumber;
  if (sequence === undefined) {
    const count = await query<{ count: string }>(
      'SELECT COUNT(*) FROM proof_photos WHERE proof_id = $1 FOR UPDATE',
      [params.proofId],
    );
    sequence = Number(count.rows[0].count) + 1;
  }
  return query<ProofPhoto>(
    `INSERT INTO proof_photos (
      proof_id, storage_key, content_type, file_size_bytes,
      checksum_sha256, capture_time, sequence_number
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      params.proofId, params.storageKey, params.contentType, params.fileSizeBytes,
      params.checksumSha256, params.captureTime, sequence,
    ],
  );
}

export async function addProofPhoto(params: AddPhotoParams): Promise<ServiceResult<ProofPhoto>> {
  try {
    const result = await db.transaction((query) => insertPhoto(query, params));
    return { success: true, data: result.rows[0] };
  } catch (error) {
    return databaseFailure(error);
  }
}

async function insertVideo(query: Parameters<Parameters<typeof db.transaction>[0]>[0], params: AddVideoParams) {
  let sequence = params.sequenceNumber;
  if (sequence === undefined) {
    const count = await query<{ count: string }>(
      'SELECT COUNT(*) FROM proof_videos WHERE proof_id = $1 FOR UPDATE',
      [params.proofId],
    );
    sequence = Number(count.rows[0].count) + 1;
  }
  return query<ProofVideo>(
    `INSERT INTO proof_videos (
      proof_id, storage_key, content_type, file_size_bytes,
      duration_seconds, sequence_number
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [
      params.proofId,
      params.storageKey,
      params.contentType ?? 'video/mp4',
      params.fileSizeBytes ?? null,
      params.durationSeconds ?? null,
      sequence,
    ],
  );
}

export async function addProofVideo(params: AddVideoParams): Promise<ServiceResult<ProofVideo>> {
  try {
    const result = await db.transaction((query) => insertVideo(query, params));
    return { success: true, data: result.rows[0] };
  } catch (error) {
    return databaseFailure(error);
  }
}
