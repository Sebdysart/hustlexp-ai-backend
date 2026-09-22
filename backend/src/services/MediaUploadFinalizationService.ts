import { TRPCError } from '@trpc/server';
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { requireBusinessManagementAuthority } from './BusinessManagementAuthority.js';
import { logger } from '../logger.js';
import { backblazeB2 } from '../storage/backblaze-b2.js';
import {
  MAX_MEDIA_UPLOAD_BYTES,
  MediaSanitizationError,
  sanitizeImageBytes,
  type SanitizedImageContentType,
  verifySanitizedImageBytes,
} from './MediaSanitizationService.js';

const log = logger.child({ service: 'MediaUploadFinalizationService' });

export type MediaUploadPurpose = 'PROOF' | 'MESSAGE' | 'TASK_DRAFT_PHOTO' | 'BUSINESS_CREDENTIAL';

interface MediaUploadReceiptRow {
  id: string;
  task_id: string | null;
  task_draft_id: string | null;
  organization_id: string | null;
  uploader_id: string;
  purpose: MediaUploadPurpose;
  status: 'QUARANTINED' | 'FINALIZED' | 'CONSUMED' | 'REJECTED' | 'EXPIRED';
  quarantine_key: string;
  expected_content_type: SanitizedImageContentType;
  expected_size_bytes: number;
  canonical_key: string | null;
  canonical_url: string | null;
  canonical_content_type: SanitizedImageContentType | null;
  canonical_size_bytes: number | null;
  canonical_checksum_sha256: string | null;
  pixel_width: number | null;
  pixel_height: number | null;
  source_metadata_detected: boolean | null;
  quarantine_expires_at: Date | string;
  expires_at: Date | string;
}

export interface FinalizedMediaEvidence {
  uploadReceiptId: string;
  contentType: SanitizedImageContentType;
  fileSizeBytes: number;
  checksumSha256: string;
  width: number;
  height: number;
  sourceMetadataDetected: boolean;
}

interface MediaStorage {
  downloadFile: typeof backblazeB2.downloadFile;
  uploadFile: typeof backblazeB2.uploadFile;
  deleteFile: typeof backblazeB2.deleteFile;
}

const CANONICAL_EXTENSION: Record<SanitizedImageContentType, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function canonicalMediaKey(row: MediaUploadReceiptRow): string {
  const target = row.organization_id ? `businesses/${row.organization_id}` : row.task_draft_id ? `task-drafts/${row.task_draft_id}` : `tasks/${row.task_id}`;
  return `media/${row.purpose.toLowerCase()}/${target}/${row.uploader_id}/${row.id}.${CANONICAL_EXTENSION[row.expected_content_type]}`;
}

function finalizedEvidence(row: MediaUploadReceiptRow): FinalizedMediaEvidence {
  if (!row.canonical_key
      || row.canonical_url !== null
      || !row.canonical_content_type
      || !row.canonical_size_bytes
      || !row.canonical_checksum_sha256
      || !row.pixel_width
      || !row.pixel_height
      || row.source_metadata_detected === null) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Finalized media receipt is incomplete.',
    });
  }
  return {
    uploadReceiptId: row.id,
    contentType: row.canonical_content_type,
    fileSizeBytes: Number(row.canonical_size_bytes),
    checksumSha256: row.canonical_checksum_sha256,
    width: Number(row.pixel_width),
    height: Number(row.pixel_height),
    sourceMetadataDetected: row.source_metadata_detected,
  };
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function recoverCanonicalFinalization(
  row: MediaUploadReceiptRow,
  params: { receiptId: string; taskId?: string; taskDraftId?: string; organizationId?: string; uploaderId: string; purpose: MediaUploadPurpose },
  storage: MediaStorage,
): Promise<FinalizedMediaEvidence | null> {
  const canonicalKey = canonicalMediaKey(row);
  let stored;
  try {
    stored = await storage.downloadFile(canonicalKey, MAX_MEDIA_UPLOAD_BYTES);
  } catch {
    return null;
  }

  let width: number;
  let height: number;
  let sourceMetadataDetected: boolean;
  let checksum: string;
  try {
    const verified = await verifySanitizedImageBytes(stored.data, row.expected_content_type);
    const attestedWidth = parsePositiveInteger(stored.metadata['pixel-width']);
    const attestedHeight = parsePositiveInteger(stored.metadata['pixel-height']);
    const sourceMetadata = stored.metadata['source-metadata-detected'];
    checksum = createHash('sha256').update(stored.data).digest('hex');
    if (stored.size !== stored.data.length
        || stored.contentType !== row.expected_content_type
        || stored.metadata['receipt-id'] !== row.id
        || (row.organization_id
          ? stored.metadata['organization-id'] !== row.organization_id
          : row.task_draft_id
          ? stored.metadata['task-draft-id'] !== row.task_draft_id
          : stored.metadata['task-id'] !== row.task_id)
        || stored.metadata['uploaded-by'] !== row.uploader_id
        || stored.metadata.purpose !== row.purpose.toLowerCase()
        || stored.metadata.sanitized !== 'true'
        || stored.metadata.sha256 !== checksum
        || attestedWidth !== verified.width
        || attestedHeight !== verified.height
        || (sourceMetadata !== 'true' && sourceMetadata !== 'false')) {
      throw new Error('Canonical object attestation did not match its verified bytes.');
    }
    width = verified.width;
    height = verified.height;
    sourceMetadataDetected = sourceMetadata === 'true';
  } catch (error) {
    await storage.deleteFile(canonicalKey).catch(() => undefined);
    log.error({ err: error, receiptId: row.id }, 'Canonical media recovery validation failed');
    return null;
  }

  const updated = await db.query<MediaUploadReceiptRow>(
    `UPDATE media_upload_receipts
        SET status='FINALIZED',
            canonical_key=$2,
            canonical_url=NULL,
            canonical_content_type=$3,
            canonical_size_bytes=$4,
            canonical_checksum_sha256=$5,
            pixel_width=$6,
            pixel_height=$7,
            source_metadata_detected=$8,
            raw_deleted_at=NOW(),
            finalized_at=NOW()
      WHERE id=$1 AND status='QUARANTINED'
      RETURNING *`,
    [
      row.id,
      canonicalKey,
      row.expected_content_type,
      stored.size,
      checksum,
      width,
      height,
      sourceMetadataDetected,
    ],
  );
  if (updated.rows[0]) return finalizedEvidence(updated.rows[0]);

  const replay = await db.query<MediaUploadReceiptRow>(
    'SELECT * FROM media_upload_receipts WHERE id=$1',
    [row.id],
  );
  assertReceiptAuthority(replay.rows[0], params);
  return replay.rows[0].status === 'FINALIZED' ? finalizedEvidence(replay.rows[0]) : null;
}

function assertReceiptAuthority(
  row: MediaUploadReceiptRow | undefined,
  params: { receiptId: string; taskId?: string; taskDraftId?: string; organizationId?: string; uploaderId: string; purpose: MediaUploadPurpose },
): asserts row is MediaUploadReceiptRow {
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Upload receipt was not found.' });
  }
  if (row.id !== params.receiptId
      || (params.taskId !== undefined && row.task_id !== params.taskId)
      || (params.taskDraftId !== undefined && row.task_draft_id !== params.taskDraftId)
      || (params.organizationId !== undefined && row.organization_id !== params.organizationId)
      || row.uploader_id !== params.uploaderId
      || row.purpose !== params.purpose) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Upload receipt is outside your task authority.' });
  }
}

async function rejectAndDeleteRaw(
  row: MediaUploadReceiptRow,
  rejectionCode: string,
  storage: MediaStorage,
): Promise<void> {
  await storage.deleteFile(row.quarantine_key);
  await db.query(
    `UPDATE media_upload_receipts
        SET status='REJECTED', raw_deleted_at=NOW(), rejection_code=$2
      WHERE id=$1 AND status='QUARANTINED'`,
    [row.id, rejectionCode],
  );
}

function validateStoredObject(row: MediaUploadReceiptRow, stored: {
  size: number;
  contentType?: string;
  metadata: Record<string, string>;
}): string | null {
  if (stored.size !== Number(row.expected_size_bytes)) return 'UPLOAD_SIZE_MISMATCH';
  if (stored.contentType !== row.expected_content_type) return 'UPLOAD_TYPE_MISMATCH';
  if (stored.metadata['receipt-id'] !== row.id
      || (row.organization_id
        ? stored.metadata['organization-id'] !== row.organization_id
        : row.task_draft_id
        ? stored.metadata['task-draft-id'] !== row.task_draft_id
        : stored.metadata['task-id'] !== row.task_id)
      || stored.metadata['uploaded-by'] !== row.uploader_id
      || stored.metadata.purpose !== row.purpose.toLowerCase()) {
    return 'UPLOAD_ATTESTATION_MISMATCH';
  }
  return null;
}

export async function finalizeMediaUpload(
  params: {
    receiptId: string;
    taskId?: string;
    taskDraftId?: string;
    organizationId?: string;
    uploaderId: string;
    purpose: MediaUploadPurpose;
  },
  storage: MediaStorage = backblazeB2,
): Promise<FinalizedMediaEvidence> {
  const receipt = await db.query<MediaUploadReceiptRow>(
    `SELECT * FROM media_upload_receipts WHERE id=$1`,
    [params.receiptId],
  );
  const row = receipt.rows[0];
  if (params.purpose === 'BUSINESS_CREDENTIAL') {
    if (!params.organizationId || params.taskId || params.taskDraftId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Credential finalization requires an exact business organization.' });
    assertReceiptAuthority(row, params);
    if (row.task_id !== null || row.task_draft_id !== null) throw new TRPCError({ code: 'FORBIDDEN', message: 'Credential receipt has an invalid target.' });
    await requireBusinessManagementAuthority(db.query, params.uploaderId, params.organizationId, 'MANAGE_SERVICES');
  } else if (params.purpose === 'TASK_DRAFT_PHOTO') {
    if (!params.taskDraftId || params.taskId || params.organizationId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Draft photo finalization requires a task draft.' });
    if (!row || row.id !== params.receiptId || row.task_id !== null || row.task_draft_id !== params.taskDraftId || (params.organizationId !== undefined && row.organization_id !== params.organizationId)
      || row.uploader_id !== params.uploaderId || row.purpose !== params.purpose) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Upload receipt is outside your draft authority.' });
    }
    const owner = await db.query<{ poster_user_id: string | null }>('SELECT poster_user_id FROM task_drafts WHERE id=$1', [params.taskDraftId]);
    if (owner.rows[0]?.poster_user_id !== params.uploaderId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the draft owner can finalize draft photos.' });
  } else {
    if (!params.taskId || params.taskDraftId || params.organizationId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task upload finalization requires a task.' });
    assertReceiptAuthority(row, { receiptId: params.receiptId, taskId: params.taskId, uploaderId: params.uploaderId, purpose: params.purpose });
  }

  if (row.status === 'FINALIZED' || (params.purpose === 'TASK_DRAFT_PHOTO' && row.status === 'CONSUMED')) return finalizedEvidence(row);
  if (row.status !== 'QUARANTINED') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Upload receipt is ${row.status.toLowerCase()} and cannot be finalized.`,
    });
  }
  if (new Date(row.quarantine_expires_at).getTime() <= Date.now()) {
    await rejectAndDeleteRaw(row, 'UPLOAD_EXPIRED', storage);
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Upload receipt expired.' });
  }

  let stored;
  try {
    stored = await storage.downloadFile(row.quarantine_key, MAX_MEDIA_UPLOAD_BYTES);
  } catch (error) {
    const recovered = await recoverCanonicalFinalization(row, params, storage);
    if (recovered) return recovered;
    log.warn({ err: error, receiptId: row.id }, 'Quarantine object was unavailable for finalization');
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Uploaded image is not available yet. Retry the upload before submitting it.',
    });
  }

  const storageMismatch = validateStoredObject(row, stored);
  if (storageMismatch) {
    await rejectAndDeleteRaw(row, storageMismatch, storage);
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Uploaded image did not match its signed contract.' });
  }

  let sanitized;
  try {
    sanitized = await sanitizeImageBytes(stored.data, row.expected_content_type);
  } catch (error) {
    const rejectionCode = error instanceof MediaSanitizationError ? error.code : 'INVALID_IMAGE';
    await rejectAndDeleteRaw(row, rejectionCode, storage);
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: error instanceof Error ? error.message : 'Uploaded image could not be sanitized.',
    });
  }

  const canonicalKey = canonicalMediaKey(row);
  try {
    await storage.uploadFile(canonicalKey, sanitized.data, sanitized.contentType, {
      'receipt-id': row.id,
      ...(row.organization_id
        ? { 'organization-id': row.organization_id }
        : row.task_draft_id
        ? { 'task-draft-id': row.task_draft_id }
        : { 'task-id': row.task_id as string }),
      'uploaded-by': row.uploader_id,
      purpose: row.purpose.toLowerCase(),
      sanitized: 'true',
      'pixel-width': String(sanitized.width),
      'pixel-height': String(sanitized.height),
      'source-metadata-detected': String(sanitized.sourceMetadataDetected),
    });
    await storage.deleteFile(row.quarantine_key);
  } catch (error) {
    await storage.deleteFile(canonicalKey).catch(() => undefined);
    log.error({ err: error, receiptId: row.id }, 'Canonical media write or quarantine deletion failed');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Image sanitation could not be committed. The upload was not accepted.',
    });
  }

  const updated = await db.query<MediaUploadReceiptRow>(
    `UPDATE media_upload_receipts
        SET status='FINALIZED',
            canonical_key=$2,
            canonical_url=NULL,
            canonical_content_type=$3,
            canonical_size_bytes=$4,
            canonical_checksum_sha256=$5,
            pixel_width=$6,
            pixel_height=$7,
            source_metadata_detected=$8,
            raw_deleted_at=NOW(),
            finalized_at=NOW()
      WHERE id=$1 AND status='QUARANTINED'
      RETURNING *`,
    [
      row.id,
      canonicalKey,
      sanitized.contentType,
      sanitized.sizeBytes,
      sanitized.checksumSha256,
      sanitized.width,
      sanitized.height,
      sanitized.sourceMetadataDetected,
    ],
  );
  if (updated.rows[0]) return finalizedEvidence(updated.rows[0]);

  const replay = await db.query<MediaUploadReceiptRow>('SELECT * FROM media_upload_receipts WHERE id=$1', [row.id]);
  assertReceiptAuthority(replay.rows[0], params);
  if (replay.rows[0].status === 'FINALIZED') return finalizedEvidence(replay.rows[0]);
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'Upload finalization raced with another terminal action. Refresh before retrying.',
  });
}

export async function expireMediaUploadReceipts(limit = 100): Promise<{
  expired: number;
  failed: number;
}> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || 100, 500));
  const due = await db.query<MediaUploadReceiptRow>(
    `SELECT * FROM media_upload_receipts
      WHERE (status='QUARANTINED' AND quarantine_expires_at <= NOW())
         OR (status='FINALIZED' AND expires_at <= NOW())
      ORDER BY LEAST(quarantine_expires_at, expires_at), id
      LIMIT $1`,
    [boundedLimit],
  );
  let expired = 0;
  let failed = 0;
  for (const row of due.rows) {
    try {
      await backblazeB2.deleteFile(row.quarantine_key);
      if (row.canonical_key) await backblazeB2.deleteFile(row.canonical_key);
      const updated = await db.query(
        `UPDATE media_upload_receipts
            SET status='EXPIRED',
                canonical_key=NULL,
                canonical_url=NULL,
                canonical_content_type=NULL,
                canonical_size_bytes=NULL,
                canonical_checksum_sha256=NULL,
                pixel_width=NULL,
                pixel_height=NULL,
                source_metadata_detected=NULL,
                raw_deleted_at=NOW(),
                finalized_at=NULL,
                rejection_code='UPLOAD_EXPIRED'
          WHERE id=$1
            AND ((status='QUARANTINED' AND quarantine_expires_at <= NOW())
              OR (status='FINALIZED' AND expires_at <= NOW()))
          RETURNING id`,
        [row.id],
      );
      if (updated.rows[0]) expired += 1;
    } catch (error) {
      failed += 1;
      log.error({ err: error, receiptId: row.id }, 'Expired media object cleanup failed');
    }
  }
  return { expired, failed };
}

