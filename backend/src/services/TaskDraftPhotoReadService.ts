import { db, type QueryFn } from '../db.js';
import {
  issueTaskDraftPhotoAccess,
  type TaskDraftPhotoAccessAuthority,
} from './PrivateMediaDeliveryService.js';

export interface DeliveredTaskDraftPhoto {
  id: string;
  uploadReceiptId: string;
  sequenceNumber: number;
  downloadUrl: string;
  contentType: string;
  fileSizeBytes: number;
  width: number;
  height: number;
}

interface TaskDraftPhotoRow {
  id: string;
  upload_receipt_id: string;
  sequence_number: number;
  canonical_key: string;
  canonical_content_type: string;
  canonical_size_bytes: number;
  pixel_width: number;
  pixel_height: number;
}

interface TaskDraftPhotoReadDependencies {
  query?: QueryFn;
  issueAccess?: typeof issueTaskDraftPhotoAccess;
}

export async function listDeliveredTaskDraftPhotos(
  params: {
    taskDraftId: string;
    authority: TaskDraftPhotoAccessAuthority;
  },
  dependencies: TaskDraftPhotoReadDependencies = {},
): Promise<DeliveredTaskDraftPhoto[]> {
  const query = dependencies.query ?? db.query;
  const issueAccess = dependencies.issueAccess ?? issueTaskDraftPhotoAccess;
  const result = await query<TaskDraftPhotoRow>(
    `SELECT p.id, p.upload_receipt_id, p.sequence_number,
            r.canonical_key, r.canonical_content_type, r.canonical_size_bytes,
            r.pixel_width, r.pixel_height
       FROM task_draft_photos p
       JOIN media_upload_receipts r ON r.id = p.upload_receipt_id
      WHERE p.task_draft_id = $1
        AND r.status IN ('FINALIZED', 'CONSUMED')
      ORDER BY p.sequence_number`,
    [params.taskDraftId],
  );

  const signed = await issueAccess({
    taskDraftId: params.taskDraftId,
    authority: params.authority,
    storageKeys: result.rows.map((row) => ({ photoId: row.id, storageKey: row.canonical_key })),
  });

  return result.rows.flatMap((row) => {
    const delivery = signed.get(row.id);
    return delivery ? [{
      id: row.id,
      uploadReceiptId: row.upload_receipt_id,
      sequenceNumber: row.sequence_number,
      downloadUrl: delivery.downloadUrl,
      contentType: row.canonical_content_type,
      fileSizeBytes: Number(row.canonical_size_bytes),
      width: Number(row.pixel_width),
      height: Number(row.pixel_height),
    }] : [];
  });
}
