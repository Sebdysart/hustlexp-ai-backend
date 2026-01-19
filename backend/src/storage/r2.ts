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

import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';
import { config } from '../config';

// ============================================================================
// R2 CLIENT
// ============================================================================

/**
 * Create R2 S3 client
 * R2 is S3-compatible, but uses custom endpoint
 * Format: https://{accountId}.r2.cloudflarestorage.com
 */
function createR2Client(): S3Client {
  const { accountId, accessKeyId, secretAccessKey } = config.cloudflare.r2;
  
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 configuration missing (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY required)');
  }
  
  // R2 endpoint format: https://{accountId}.r2.cloudflarestorage.com
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  
  return new S3Client({
    region: 'auto', // R2 uses 'auto' for region
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

const r2Client = createR2Client();
const bucketName = config.cloudflare.r2.bucketName;

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
  contentType: string = 'application/octet-stream'
): Promise<UploadResult> {
  // Calculate SHA256 checksum
  const sha256 = createHash('sha256').update(data).digest('hex');
  
  // Upload to R2
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: data,
    ContentType: contentType,
    Metadata: {
      sha256, // Store checksum in metadata for verification
    },
  });
  
  await r2Client.send(command);
  
  return {
    key,
    size: data.length,
    sha256,
    contentType,
  };
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
    Bucket: bucketName,
    Key: key,
  });
  
  try {
    await r2Client.send(headCommand);
  } catch (error) {
    throw new Error(`R2 object not found: ${key}`);
  }
  
  // Generate presigned URL
  const getCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });
  
  const signedUrl = await getSignedUrl(r2Client, getCommand, {
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
      Bucket: bucketName,
      Key: key,
    });
    
    const response = await r2Client.send(command);
    
    return {
      exists: true,
      size: response.ContentLength,
      contentType: response.ContentType,
      sha256: response.Metadata?.sha256,
      lastModified: response.LastModified,
    };
  } catch (error) {
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
  getSignedUrlForObject,
  verifyFile,
};
