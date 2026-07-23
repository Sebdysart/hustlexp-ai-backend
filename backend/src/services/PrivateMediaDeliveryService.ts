import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import { r2 } from '../storage/r2.js';
import type { ProofPhoto } from '../types.js';
import type { TaskMessage } from './MessagingTypes.js';

const log = logger.child({ service: 'PrivateMediaDeliveryService' });
export const PRIVATE_MEDIA_URL_TTL_SECONDS = 5 * 60;

export type PrivateMediaPurpose = 'PROOF' | 'MESSAGE';
export type PrivateMediaAccessReason =
  | 'PROOF_REVIEW'
  | 'MESSAGE_THREAD'
  | 'BIOMETRIC_ANALYSIS'
  | 'MODERATION_REVIEW';

export interface PrivateMediaReference {
  consumerId: string;
  storageKey: string;
}

export interface DeliveredPrivateMedia {
  downloadUrl: string;
  expiresAt: string;
}

export type MediaDeliveryStatus = 'NONE' | 'READY' | 'PARTIAL' | 'UNAVAILABLE';

export type DeliveredProofPhoto = Omit<ProofPhoto, 'storage_key'> & {
  download_url: string | null;
  download_expires_at: string | null;
  delivery_status: Exclude<MediaDeliveryStatus, 'NONE' | 'PARTIAL'>;
};

export type DeliveredTaskMessage = TaskMessage & {
  photo_delivery_status: MediaDeliveryStatus;
  photo_urls_expires_at: string | null;
};

interface AuthorizedReceiptRow {
  ordinal: number;
  receipt_id: string;
  task_id: string;
  consumer_id: string;
  storage_key: string;
}

interface SignedReceipt extends AuthorizedReceiptRow {
  downloadUrl: string;
  expiresAt: string;
}

export interface DeliveryDependencies {
  query?: QueryFn;
  signObject?: (key: string, expiresInSeconds: number) => Promise<string>;
  now?: () => Date;
}

function referenceIdentity(reference: PrivateMediaReference): string {
  return `${reference.consumerId}\u0000${reference.storageKey}`;
}

function authorizedRequestPayload(references: PrivateMediaReference[]): string {
  return JSON.stringify(references.map((reference, ordinal) => ({
    ordinal,
    consumer_id: reference.consumerId,
    storage_key: reference.storageKey,
  })));
}

function assertSafeSignedUrl(value: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Private media signer returned an unsafe URL.');
  }
}

function accessReasonMatchesPurpose(
  purpose: PrivateMediaPurpose,
  reason: PrivateMediaAccessReason,
): boolean {
  if (purpose === 'MESSAGE') return reason === 'MESSAGE_THREAD';
  return reason === 'PROOF_REVIEW' || reason === 'BIOMETRIC_ANALYSIS';
}

async function loadAuthorizedReceipts(
  query: QueryFn,
  params: {
    taskId: string;
    viewerId: string;
    purpose: PrivateMediaPurpose;
    references: PrivateMediaReference[];
  },
): Promise<AuthorizedReceiptRow[]> {
  const result = await query<AuthorizedReceiptRow>(
    `WITH requested AS (
       SELECT ordinal, consumer_id, storage_key
       FROM jsonb_to_recordset($4::jsonb)
         AS item(ordinal INTEGER, consumer_id UUID, storage_key TEXT)
     )
     SELECT requested.ordinal,
            receipt.id AS receipt_id,
            receipt.task_id::TEXT AS task_id,
            requested.consumer_id::TEXT AS consumer_id,
            requested.storage_key
     FROM requested
     JOIN media_upload_receipts receipt
       ON receipt.task_id = $1
      AND receipt.status = 'CONSUMED'
      AND receipt.purpose = $3
      AND receipt.consumed_kind = $3
      AND receipt.consumed_id = requested.consumer_id
      AND receipt.canonical_key = requested.storage_key
      AND receipt.canonical_key IS NOT NULL
      AND receipt.canonical_url IS NULL
     JOIN tasks task ON task.id = receipt.task_id
     WHERE task.poster_id = $2 OR task.worker_id = $2
     ORDER BY requested.ordinal`,
    [
      params.taskId,
      params.viewerId,
      params.purpose,
      authorizedRequestPayload(params.references),
    ],
  );
  return result.rows;
}

async function loadAuthorizedSystemReceipts(
  query: QueryFn,
  params: {
    taskId: string;
    purpose: PrivateMediaPurpose;
    references: PrivateMediaReference[];
  },
): Promise<AuthorizedReceiptRow[]> {
  const result = await query<AuthorizedReceiptRow>(
    `WITH requested AS (
       SELECT ordinal, consumer_id, storage_key
       FROM jsonb_to_recordset($3::jsonb)
         AS item(ordinal INTEGER, consumer_id UUID, storage_key TEXT)
     )
     SELECT requested.ordinal,
            receipt.id AS receipt_id,
            receipt.task_id::TEXT AS task_id,
            requested.consumer_id::TEXT AS consumer_id,
            requested.storage_key
     FROM requested
     JOIN media_upload_receipts receipt
       ON receipt.task_id = $1
      AND receipt.status = 'CONSUMED'
      AND receipt.purpose = $2
      AND receipt.consumed_kind = $2
      AND receipt.consumed_id = requested.consumer_id
      AND receipt.canonical_key = requested.storage_key
      AND receipt.canonical_key IS NOT NULL
      AND receipt.canonical_url IS NULL
     ORDER BY requested.ordinal`,
    [params.taskId, params.purpose, authorizedRequestPayload(params.references)],
  );
  return result.rows;
}

async function loadAuthorizedAdminReceipts(
  query: QueryFn,
  adminId: string,
  references: PrivateMediaReference[],
): Promise<AuthorizedReceiptRow[]> {
  const result = await query<AuthorizedReceiptRow>(
    `WITH requested AS (
       SELECT ordinal, consumer_id, storage_key
       FROM jsonb_to_recordset($2::jsonb)
         AS item(ordinal INTEGER, consumer_id UUID, storage_key TEXT)
     )
     SELECT requested.ordinal,
            receipt.id AS receipt_id,
            receipt.task_id::TEXT AS task_id,
            requested.consumer_id::TEXT AS consumer_id,
            requested.storage_key
     FROM requested
     JOIN media_upload_receipts receipt
       ON receipt.status = 'CONSUMED'
      AND receipt.purpose = 'MESSAGE'
      AND receipt.consumed_kind = 'MESSAGE'
      AND receipt.consumed_id = requested.consumer_id
      AND receipt.canonical_key = requested.storage_key
      AND receipt.canonical_key IS NOT NULL
      AND receipt.canonical_url IS NULL
     JOIN admin_roles role
       ON role.user_id = $1
      AND role.can_modify_trust = TRUE
     ORDER BY requested.ordinal`,
    [adminId, authorizedRequestPayload(references)],
  );
  return result.rows;
}

async function storeAccessAudit(
  query: QueryFn,
  params: {
    taskId: string;
    viewerId: string;
    purpose: PrivateMediaPurpose;
    accessReason: PrivateMediaAccessReason;
    signed: SignedReceipt[];
  },
): Promise<Set<string>> {
  if (params.signed.length === 0) return new Set();
  const auditPayload = JSON.stringify(params.signed.map((item) => ({
    receipt_id: item.receipt_id,
    consumer_id: item.consumer_id,
    storage_key: item.storage_key,
    expires_at: item.expiresAt,
  })));
  const result = await query<{ receipt_id: string }>(
    `WITH requested AS (
       SELECT receipt_id, consumer_id, storage_key, expires_at
       FROM jsonb_to_recordset($5::jsonb)
         AS item(receipt_id UUID, consumer_id UUID, storage_key TEXT, expires_at TIMESTAMPTZ)
     ), authorized AS (
       SELECT requested.receipt_id, requested.consumer_id, requested.expires_at
       FROM requested
       JOIN media_upload_receipts receipt
         ON receipt.id = requested.receipt_id
        AND receipt.task_id = $1
        AND receipt.status = 'CONSUMED'
        AND receipt.purpose = $3
        AND receipt.consumed_kind = $3
        AND receipt.consumed_id = requested.consumer_id
        AND receipt.canonical_key = requested.storage_key
        AND receipt.canonical_url IS NULL
       JOIN tasks task ON task.id = receipt.task_id
       WHERE task.poster_id = $2 OR task.worker_id = $2
     )
     INSERT INTO media_access_log (
       receipt_id, task_id, viewer_id, actor_kind, purpose,
       consumer_id, access_reason, signed_url_expires_at
     )
     SELECT receipt_id, $1, $2, 'USER', $3,
            consumer_id, $4, expires_at
     FROM authorized
     RETURNING receipt_id`,
    [params.taskId, params.viewerId, params.purpose, params.accessReason, auditPayload],
  );
  return new Set(result.rows.map((row) => row.receipt_id));
}

async function storeSystemAccessAudit(
  query: QueryFn,
  params: {
    taskId: string;
    purpose: PrivateMediaPurpose;
    accessReason: PrivateMediaAccessReason;
    signed: SignedReceipt[];
  },
): Promise<Set<string>> {
  if (params.signed.length === 0) return new Set();
  const auditPayload = JSON.stringify(params.signed.map((item) => ({
    receipt_id: item.receipt_id,
    consumer_id: item.consumer_id,
    storage_key: item.storage_key,
    expires_at: item.expiresAt,
  })));
  const result = await query<{ receipt_id: string }>(
    `WITH requested AS (
       SELECT receipt_id, consumer_id, storage_key, expires_at
       FROM jsonb_to_recordset($4::jsonb)
         AS item(receipt_id UUID, consumer_id UUID, storage_key TEXT, expires_at TIMESTAMPTZ)
     ), authorized AS (
       SELECT requested.receipt_id, requested.consumer_id, requested.expires_at
       FROM requested
       JOIN media_upload_receipts receipt
         ON receipt.id = requested.receipt_id
        AND receipt.task_id = $1
        AND receipt.status = 'CONSUMED'
        AND receipt.purpose = $2
        AND receipt.consumed_kind = $2
        AND receipt.consumed_id = requested.consumer_id
        AND receipt.canonical_key = requested.storage_key
        AND receipt.canonical_url IS NULL
     )
     INSERT INTO media_access_log (
       receipt_id, task_id, viewer_id, actor_kind, purpose,
       consumer_id, access_reason, signed_url_expires_at
     )
     SELECT receipt_id, $1, NULL, 'SYSTEM', $2,
            consumer_id, $3, expires_at
     FROM authorized
     RETURNING receipt_id`,
    [params.taskId, params.purpose, params.accessReason, auditPayload],
  );
  return new Set(result.rows.map((row) => row.receipt_id));
}

async function storeAdminAccessAudit(
  query: QueryFn,
  adminId: string,
  signed: SignedReceipt[],
): Promise<Set<string>> {
  if (signed.length === 0) return new Set();
  const auditPayload = JSON.stringify(signed.map((item) => ({
    receipt_id: item.receipt_id,
    task_id: item.task_id,
    consumer_id: item.consumer_id,
    storage_key: item.storage_key,
    expires_at: item.expiresAt,
  })));
  const result = await query<{ receipt_id: string }>(
    `WITH requested AS (
       SELECT receipt_id, task_id, consumer_id, storage_key, expires_at
       FROM jsonb_to_recordset($2::jsonb)
         AS item(receipt_id UUID, task_id UUID, consumer_id UUID,
                 storage_key TEXT, expires_at TIMESTAMPTZ)
     ), authorized AS (
       SELECT requested.receipt_id, requested.task_id,
              requested.consumer_id, requested.expires_at
       FROM requested
       JOIN media_upload_receipts receipt
         ON receipt.id = requested.receipt_id
        AND receipt.task_id = requested.task_id
        AND receipt.status = 'CONSUMED'
        AND receipt.purpose = 'MESSAGE'
        AND receipt.consumed_kind = 'MESSAGE'
        AND receipt.consumed_id = requested.consumer_id
        AND receipt.canonical_key = requested.storage_key
        AND receipt.canonical_url IS NULL
       JOIN admin_roles role
         ON role.user_id = $1
        AND role.can_modify_trust = TRUE
     )
     INSERT INTO media_access_log (
       receipt_id, task_id, viewer_id, actor_kind, purpose,
       consumer_id, access_reason, signed_url_expires_at
     )
     SELECT receipt_id, task_id, $1, 'ADMIN', 'MESSAGE',
            consumer_id, 'MODERATION_REVIEW', expires_at
     FROM authorized
     RETURNING receipt_id`,
    [adminId, auditPayload],
  );
  return new Set(result.rows.map((row) => row.receipt_id));
}

/**
 * Issue receipt-bound URLs only after current participant authorization. URL
 * generation happens before the audit insert, but a URL is returned only when
 * the matching append-only audit row commits successfully.
 */
export async function issueParticipantMediaAccess(
  params: {
    taskId: string;
    viewerId: string;
    purpose: PrivateMediaPurpose;
    accessReason: PrivateMediaAccessReason;
    references: PrivateMediaReference[];
  },
  dependencies: DeliveryDependencies = {},
): Promise<Map<string, DeliveredPrivateMedia>> {
  if (!accessReasonMatchesPurpose(params.purpose, params.accessReason)) {
    throw new Error('Private media access reason does not match its purpose.');
  }
  if (params.references.length === 0) return new Map();
  if (params.references.length > 300) throw new Error('Private media request exceeds the bounded batch size.');

  const query = dependencies.query ?? db.query;
  const signObject = dependencies.signObject ?? r2.getSignedUrlForObject;
  const now = dependencies.now ?? (() => new Date());
  const authorized = await loadAuthorizedReceipts(query, params);
  const signed: SignedReceipt[] = [];
  for (const row of authorized) {
    try {
      const downloadUrl = await signObject(row.storage_key, PRIVATE_MEDIA_URL_TTL_SECONDS);
      assertSafeSignedUrl(downloadUrl);
      signed.push({
        ...row,
        downloadUrl,
        expiresAt: new Date(now().getTime() + PRIVATE_MEDIA_URL_TTL_SECONDS * 1000).toISOString(),
      });
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error), receiptId: row.receipt_id },
        'Private media signing failed',
      );
    }
  }

  const auditedReceiptIds = await storeAccessAudit(query, {
    taskId: params.taskId,
    viewerId: params.viewerId,
    purpose: params.purpose,
    accessReason: params.accessReason,
    signed,
  });
  const delivered = new Map<string, DeliveredPrivateMedia>();
  for (const item of signed) {
    if (!auditedReceiptIds.has(item.receipt_id)) continue;
    delivered.set(referenceIdentity({
      consumerId: item.consumer_id,
      storageKey: item.storage_key,
    }), {
      downloadUrl: item.downloadUrl,
      expiresAt: item.expiresAt,
    });
  }
  return delivered;
}

export async function issueSystemMediaAccess(
  params: {
    taskId: string;
    purpose: PrivateMediaPurpose;
    accessReason: PrivateMediaAccessReason;
    references: PrivateMediaReference[];
  },
  dependencies: DeliveryDependencies = {},
): Promise<Map<string, DeliveredPrivateMedia>> {
  if (!accessReasonMatchesPurpose(params.purpose, params.accessReason)) {
    throw new Error('Private media access reason does not match its purpose.');
  }
  if (params.references.length === 0) return new Map();
  if (params.references.length > 100) throw new Error('System media request exceeds the bounded batch size.');

  const query = dependencies.query ?? db.query;
  const signObject = dependencies.signObject ?? r2.getSignedUrlForObject;
  const now = dependencies.now ?? (() => new Date());
  const authorized = await loadAuthorizedSystemReceipts(query, params);
  const signed: SignedReceipt[] = [];
  for (const row of authorized) {
    try {
      const downloadUrl = await signObject(row.storage_key, PRIVATE_MEDIA_URL_TTL_SECONDS);
      assertSafeSignedUrl(downloadUrl);
      signed.push({
        ...row,
        downloadUrl,
        expiresAt: new Date(now().getTime() + PRIVATE_MEDIA_URL_TTL_SECONDS * 1000).toISOString(),
      });
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error), receiptId: row.receipt_id },
        'System media signing failed',
      );
    }
  }

  const audited = await storeSystemAccessAudit(query, {
    taskId: params.taskId,
    purpose: params.purpose,
    accessReason: params.accessReason,
    signed,
  });
  const delivered = new Map<string, DeliveredPrivateMedia>();
  for (const item of signed) {
    if (!audited.has(item.receipt_id)) continue;
    delivered.set(referenceIdentity({
      consumerId: item.consumer_id,
      storageKey: item.storage_key,
    }), { downloadUrl: item.downloadUrl, expiresAt: item.expiresAt });
  }
  return delivered;
}

export async function issueSingleSystemMediaAccess(params: {
  taskId: string;
  purpose: 'PROOF';
  accessReason: 'BIOMETRIC_ANALYSIS';
  consumerId: string;
  storageKey: string;
}): Promise<DeliveredPrivateMedia | null> {
  const delivered = await issueSystemMediaAccess({
    taskId: params.taskId,
    purpose: params.purpose,
    accessReason: params.accessReason,
    references: [{ consumerId: params.consumerId, storageKey: params.storageKey }],
  });
  return delivered.get(referenceIdentity({
    consumerId: params.consumerId,
    storageKey: params.storageKey,
  })) ?? null;
}

export async function issueAdminModerationMediaAccess(
  params: { adminId: string; references: PrivateMediaReference[] },
  dependencies: DeliveryDependencies = {},
): Promise<Map<string, DeliveredPrivateMedia>> {
  if (params.references.length === 0) return new Map();
  if (params.references.length > 100) throw new Error('Moderation media request exceeds the bounded batch size.');
  const query = dependencies.query ?? db.query;
  const signObject = dependencies.signObject ?? r2.getSignedUrlForObject;
  const now = dependencies.now ?? (() => new Date());
  const authorized = await loadAuthorizedAdminReceipts(query, params.adminId, params.references);
  const signed: SignedReceipt[] = [];
  for (const row of authorized) {
    try {
      const downloadUrl = await signObject(row.storage_key, PRIVATE_MEDIA_URL_TTL_SECONDS);
      assertSafeSignedUrl(downloadUrl);
      signed.push({
        ...row,
        downloadUrl,
        expiresAt: new Date(now().getTime() + PRIVATE_MEDIA_URL_TTL_SECONDS * 1000).toISOString(),
      });
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error), receiptId: row.receipt_id },
        'Moderation media signing failed',
      );
    }
  }
  const audited = await storeAdminAccessAudit(query, params.adminId, signed);
  const delivered = new Map<string, DeliveredPrivateMedia>();
  for (const item of signed) {
    if (!audited.has(item.receipt_id)) continue;
    delivered.set(referenceIdentity({
      consumerId: item.consumer_id,
      storageKey: item.storage_key,
    }), { downloadUrl: item.downloadUrl, expiresAt: item.expiresAt });
  }
  return delivered;
}

export async function projectModerationMediaForAdmin<T extends {
  content_type: string;
  content_id: string;
  content_url?: string | null;
}>(adminId: string, items: T[]): Promise<Array<Omit<T, 'content_url'> & {
  content_url: string | null;
  content_url_expires_at: string | null;
  media_delivery_status: MediaDeliveryStatus;
}>> {
  const references = items.flatMap((item) =>
    item.content_type === 'photo' && item.content_url
      ? [{ consumerId: item.content_id, storageKey: item.content_url }]
      : [],
  );
  let delivered = new Map<string, DeliveredPrivateMedia>();
  try {
    delivered = await issueAdminModerationMediaAccess({ adminId, references });
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error), adminId },
      'Moderation media authorization or audit failed closed',
    );
  }
  return items.map((item) => {
    const privateReference = item.content_type === 'photo' && item.content_url
      ? { consumerId: item.content_id, storageKey: item.content_url }
      : null;
    const access = privateReference ? delivered.get(referenceIdentity(privateReference)) : undefined;
    const { content_url: _privateStorageKey, ...safeItem } = item;
    return {
      ...safeItem,
      content_url: access?.downloadUrl ?? null,
      content_url_expires_at: access?.expiresAt ?? null,
      media_delivery_status: privateReference ? (access ? 'READY' : 'UNAVAILABLE') : 'NONE',
    };
  });
}

async function safeParticipantMediaAccess(
  params: Parameters<typeof issueParticipantMediaAccess>[0],
): Promise<Map<string, DeliveredPrivateMedia>> {
  try {
    return await issueParticipantMediaAccess(params);
  } catch (error) {
    log.error(
      {
        err: error instanceof Error ? error.message : String(error),
        taskId: params.taskId,
        viewerId: params.viewerId,
        purpose: params.purpose,
      },
      'Private media authorization or audit failed closed',
    );
    return new Map();
  }
}

export async function projectProofPhotosForViewer(params: {
  taskId: string;
  proofId: string;
  viewerId: string;
  photos: ProofPhoto[];
}): Promise<DeliveredProofPhoto[]> {
  const references = params.photos.map((photo) => ({
    consumerId: params.proofId,
    storageKey: photo.storage_key,
  }));
  const delivered = await safeParticipantMediaAccess({
    taskId: params.taskId,
    viewerId: params.viewerId,
    purpose: 'PROOF',
    accessReason: 'PROOF_REVIEW',
    references,
  });
  return params.photos.map((photo) => {
    const access = delivered.get(referenceIdentity({
      consumerId: params.proofId,
      storageKey: photo.storage_key,
    }));
    return {
      id: photo.id,
      proof_id: photo.proof_id,
      content_type: photo.content_type,
      file_size_bytes: photo.file_size_bytes,
      checksum_sha256: photo.checksum_sha256,
      capture_time: photo.capture_time,
      sequence_number: photo.sequence_number,
      created_at: photo.created_at,
      download_url: access?.downloadUrl ?? null,
      download_expires_at: access?.expiresAt ?? null,
      delivery_status: access ? 'READY' : 'UNAVAILABLE',
    };
  });
}

export async function projectTaskMessagesForViewer(params: {
  taskId: string;
  viewerId: string;
  messages: TaskMessage[];
}): Promise<DeliveredTaskMessage[]> {
  const references = params.messages.flatMap((message) =>
    ['flagged', 'quarantined'].includes(message.moderation_status ?? '')
      ? []
      : (message.photo_urls ?? []).map((storageKey) => ({ consumerId: message.id, storageKey })),
  );
  const delivered = await safeParticipantMediaAccess({
    taskId: params.taskId,
    viewerId: params.viewerId,
    purpose: 'MESSAGE',
    accessReason: 'MESSAGE_THREAD',
    references,
  });
  return params.messages.map((message) => {
    const underReview = ['flagged', 'quarantined'].includes(message.moderation_status ?? '');
    const privateReferences = underReview ? [] : message.photo_urls ?? [];
    const accesses = privateReferences
      .map((storageKey) => delivered.get(referenceIdentity({ consumerId: message.id, storageKey })))
      .filter((item): item is DeliveredPrivateMedia => Boolean(item));
    const photoDeliveryStatus: MediaDeliveryStatus = privateReferences.length === 0
      ? 'NONE'
      : accesses.length === privateReferences.length
        ? 'READY'
        : accesses.length > 0
          ? 'PARTIAL'
          : 'UNAVAILABLE';
    return {
      ...message,
      content: underReview ? undefined : message.content,
      photo_urls: accesses.map((item) => item.downloadUrl),
      photo_delivery_status: photoDeliveryStatus,
      photo_urls_expires_at: accesses[0]?.expiresAt ?? null,
    };
  });
}

export async function issueSingleParticipantMediaAccess(params: {
  taskId: string;
  viewerId: string;
  purpose: PrivateMediaPurpose;
  accessReason: PrivateMediaAccessReason;
  consumerId: string;
  storageKey: string;
}, dependencies: DeliveryDependencies = {}): Promise<DeliveredPrivateMedia | null> {
  const reference = { consumerId: params.consumerId, storageKey: params.storageKey };
  const delivered = await issueParticipantMediaAccess({
    taskId: params.taskId,
    viewerId: params.viewerId,
    purpose: params.purpose,
    accessReason: params.accessReason,
    references: [reference],
  }, dependencies);
  return delivered.get(referenceIdentity(reference)) ?? null;
}
