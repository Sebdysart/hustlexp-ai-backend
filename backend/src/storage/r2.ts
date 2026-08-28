/**
 * Cloudflare R2 Storage Service v1.0.0
 *
 * SYSTEM GUARANTEES: File Storage with Signed URLs
 *
 * R2 is S3-compatible object storage.
 * Uses @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner.
 *
 * Hard rule: Never serve files directly from API - always use signed URLs
 *
 * @see ARCHITECTURE.md §2.5 (File Storage)
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';
import { config } from '../config.js';

// ============================================================================
// R2 CLIENT
// ============================================================================

/**
 * Create R2 S3 client
 * R2 is S3-compatible, but uses custom endpoint
 * Format: https://{accountId}.r2.cloudflarestorage.com
 */
function createR2Client(): S3Client {
  const { endpoint, accessKeyId, secretAccessKey, region } = config.cloudflare.r2;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Object storage configuration missing (endpoint, access key, and secret key required)'
    );
  }

  return new S3Client({
    region,
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

// LAZY INIT (2026-06-11): creating the client at module scope made ANY import
// of this module throw when R2 env vars are absent — which crash-looped the
// dedicated worker process (workers.ts → export-worker.ts → this module) on
// deployments without R2 configured, taking down ALL queue processing
// (payouts, push, outbox) over an export-only dependency. The client is now
// created on first use: same error, but only when R2 is actually exercised.
let r2ClientInstance: S3Client | null = null;
function getR2Client(): S3Client {
  if (!r2ClientInstance) {
    r2ClientInstance = createR2Client();
  }
  return r2ClientInstance;
}
function getBucketName(): string {
  const bucketName = config.cloudflare?.r2?.bucketName;
  if (!bucketName) throw new Error('R2 configuration missing (R2_BUCKET_NAME required)');
  return bucketName;
}

// ============================================================================
// KEY GENERATION
// ============================================================================

/**
 * Generate R2 object key for task proof photos
 */
export function generateTaskProofKey(taskId: string, timestamp: number): string {
  return `tasks/${taskId}/proof_${timestamp}.jpg`;
}

/**
 * Generate R2 object key for GDPR exports
 * Format: exports/{user_id}/{export_id}/{yyyy-mm-dd}/{filename}
 *
 * CRITICAL: Date must be deterministic based on export's created_at, not "now"
 * This ensures retries overwrite the same key instead of creating duplicates
 */
export function generateExportKey(
  userId: string,
  exportId: string,
  format: string,
  createdAt: Date // CRITICAL: Use export's created_at, not new Date()
): string {
  const date = createdAt.toISOString().split('T')[0]; // yyyy-mm-dd from export's created_at
  const filename = `export_${exportId}.${format}`;
  return `exports/${userId}/${exportId}/${date}/${filename}`;
}

// ============================================================================
// UPLOAD
// ============================================================================

export interface UploadResult {
  key: string;
  size: number;
  sha256: string;
  contentType?: string;
}

/**
 * Upload file to R2
 *
 * @param key R2 object key (e.g., exports/{user_id}/{export_id}/{date}/{filename})
 * @param data File data (Buffer)
 * @param contentType MIME type (optional, defaults to application/octet-stream)
 * @returns Upload result with key, size, and SHA256 checksum
 */
export async function uploadFile(
  key: string,
  data: Buffer,
  contentType: string = 'application/octet-stream',
  metadata: Record<string, string> = {}
): Promise<UploadResult> {
  // Calculate SHA256 checksum
  const sha256 = createHash('sha256').update(data).digest('hex');

  // Upload to R2
  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: data,
    ContentType: contentType,
    Metadata: {
      ...metadata,
      sha256, // Store checksum in metadata for verification
    },
  });

  await getR2Client().send(command);

  return {
    key,
    size: data.length,
    sha256,
    contentType,
  };
}

export interface DownloadedFile {
  data: Buffer;
  size: number;
  contentType?: string;
  metadata: Record<string, string>;
}

/**
 * Download one bounded object for server-side validation. The HEAD check avoids
 * buffering an oversized object even if a storage policy was misconfigured.
 */
export async function downloadFile(key: string, maxBytes: number): Promise<DownloadedFile> {
  const head = await getR2Client().send(
    new HeadObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    })
  );
  const declaredSize = Number(head.ContentLength ?? -1);
  if (!Number.isInteger(declaredSize) || declaredSize < 0 || declaredSize > maxBytes) {
    throw new Error('R2 object exceeds the permitted download size.');
  }

  const response = await getR2Client().send(
    new GetObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    })
  );
  if (!response.Body) throw new Error('R2 object body is missing.');
  const bytes = await response.Body.transformToByteArray();
  if (bytes.byteLength !== declaredSize || bytes.byteLength > maxBytes) {
    throw new Error('R2 object size changed during download.');
  }
  return {
    data: Buffer.from(bytes),
    size: bytes.byteLength,
    contentType: response.ContentType ?? head.ContentType,
    metadata: { ...(head.Metadata ?? {}), ...(response.Metadata ?? {}) },
  };
}

export async function deleteFile(key: string): Promise<void> {
  await getR2Client().send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }));
}

// ============================================================================
// SIGNED URLS
// ============================================================================

/**
 * Generate signed URL for R2 object (presigned GET request)
 *
 * Hard rule: Never serve files directly from API - always use signed URLs
 *
 * @param key R2 object key
 * @param expiresInSeconds URL expiration time in seconds (default: 15 minutes)
 * @returns Signed URL that expires after specified time
 */
export async function getSignedUrlForObject(
  key: string,
  expiresInSeconds: number = 15 * 60 // 15 minutes default
): Promise<string> {
  // Verify object exists
  const headCommand = new HeadObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  try {
    await getR2Client().send(headCommand);
  } catch (_error) {
    throw new Error(`R2 object not found: ${key}`);
  }

  // Generate presigned URL
  const getCommand = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  const signedUrl = await getSignedUrl(getR2Client(), getCommand, {
    expiresIn: expiresInSeconds,
  });

  return signedUrl;
}

// ============================================================================
// VERIFICATION
// ============================================================================

/**
 * Verify file exists in R2 and return metadata
 */
export async function verifyFile(key: string): Promise<{
  exists: boolean;
  size?: number;
  contentType?: string;
  sha256?: string;
  lastModified?: Date;
}> {
  try {
    const command = new HeadObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    });

    const response = await getR2Client().send(command);

    return {
      exists: true,
      size: response.ContentLength,
      contentType: response.ContentType,
      sha256: response.Metadata?.sha256,
      lastModified: response.LastModified,
    };
  } catch (_error) {
    return { exists: false };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const r2 = {
  generateTaskProofKey,
  generateExportKey,
  uploadFile,
  downloadFile,
  deleteFile,
  getSignedUrlForObject,
  verifyFile,
};
