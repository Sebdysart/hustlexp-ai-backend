import { TRPCError } from '@trpc/server';
import type { QueryFn } from '../db.js';
import type { SanitizedImageContentType } from './MediaSanitizationService.js';
import type { MediaUploadPurpose } from './MediaUploadFinalizationService.js';

export interface ConsumedPrivateMedia {
  storageKey: string;
  contentType: SanitizedImageContentType;
  fileSizeBytes: number;
  checksumSha256: string;
}

function consumedPrivateMedia(row: {
  canonical_key: string;
  canonical_content_type: SanitizedImageContentType;
  canonical_size_bytes: number;
  canonical_checksum_sha256: string;
}): ConsumedPrivateMedia {
  return {
    storageKey: row.canonical_key,
    contentType: row.canonical_content_type,
    fileSizeBytes: Number(row.canonical_size_bytes),
    checksumSha256: row.canonical_checksum_sha256,
  };
}

export async function consumeFinalizedMediaReceipt(
  query: QueryFn,
  params: {
    evidence: {
      uploadReceiptId: string;
      contentType: string;
      fileSizeBytes: number;
      checksumSha256: string;
    };
    taskId: string;
    uploaderId: string;
    purpose: MediaUploadPurpose;
    consumerId: string;
  },
): Promise<ConsumedPrivateMedia> {
  const result = await query<{
    canonical_key: string;
    canonical_content_type: SanitizedImageContentType;
    canonical_size_bytes: number;
    canonical_checksum_sha256: string;
  }>(
    `UPDATE media_upload_receipts
        SET status='CONSUMED', consumed_kind=$5, consumed_id=$6, consumed_at=NOW()
      WHERE id=$1
        AND task_id=$2
        AND uploader_id=$3
        AND purpose=$5
        AND status='FINALIZED'
        AND expires_at > NOW()
        AND canonical_url IS NULL
        AND canonical_key IS NOT NULL
        AND canonical_content_type=$4
        AND canonical_size_bytes=$7
        AND canonical_checksum_sha256=$8
      RETURNING canonical_key, canonical_content_type,
                canonical_size_bytes, canonical_checksum_sha256`,
    [
      params.evidence.uploadReceiptId,
      params.taskId,
      params.uploaderId,
      params.evidence.contentType,
      params.purpose,
      params.consumerId,
      params.evidence.fileSizeBytes,
      params.evidence.checksumSha256.toLowerCase(),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Media evidence is not a fresh, finalized, task-bound upload.',
    });
  }
  return consumedPrivateMedia(row);
}

export async function consumeFinalizedMediaReceiptById(
  query: QueryFn,
  params: {
    uploadReceiptId: string;
    taskId: string;
    uploaderId: string;
    purpose: MediaUploadPurpose;
    consumerId: string;
  },
): Promise<ConsumedPrivateMedia> {
  const result = await query<{
    canonical_key: string;
    canonical_content_type: SanitizedImageContentType;
    canonical_size_bytes: number;
    canonical_checksum_sha256: string;
  }>(
    `UPDATE media_upload_receipts
        SET status='CONSUMED', consumed_kind=$4, consumed_id=$5, consumed_at=NOW()
      WHERE id=$1
        AND task_id=$2
        AND uploader_id=$3
        AND purpose=$4
        AND status='FINALIZED'
        AND expires_at > NOW()
        AND canonical_url IS NULL
        AND canonical_key IS NOT NULL
      RETURNING canonical_key, canonical_content_type,
                canonical_size_bytes, canonical_checksum_sha256`,
    [
      params.uploadReceiptId,
      params.taskId,
      params.uploaderId,
      params.purpose,
      params.consumerId,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Media receipt is not fresh, finalized, and task-bound.',
    });
  }
  return consumedPrivateMedia(row);
}
