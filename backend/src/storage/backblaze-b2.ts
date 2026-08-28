/**
 * Backblaze B2 Storage Service
 *
 * B2 exposes an S3-compatible API, so this adapter intentionally mirrors
 * the existing R2 storage interface.
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

function createB2Client(): S3Client {
  const {
    endpoint,
    region,
    keyId,
    applicationKey,
  } = config.backblaze.b2;

  if (!endpoint || !region || !keyId || !applicationKey) {
    throw new Error(
      'Backblaze B2 configuration missing (endpoint, region, key ID, and application key required)',
    );
  }

  return new S3Client({
    region,
    endpoint,
    credentials: {
      accessKeyId: keyId,
      secretAccessKey: applicationKey,
    },
  });
}

let b2ClientInstance: S3Client | null = null;

function getB2Client(): S3Client {
  if (!b2ClientInstance) {
    b2ClientInstance = createB2Client();
  }
  return b2ClientInstance;
}

function getBucketName(): string {
  const bucketName = config.backblaze.b2.bucketName;

  if (!bucketName) {
    throw new Error(
      'Backblaze B2 configuration missing (B2_BUCKET_NAME required)',
    );
  }

  return bucketName;
}

export function generateTaskProofKey(
  taskId: string,
  timestamp: number,
): string {
  return `tasks/${taskId}/proof_${timestamp}.jpg`;
}

export function generateExportKey(
  userId: string,
  exportId: string,
  format: string,
  createdAt: Date,
): string {
  const date = createdAt.toISOString().split('T')[0];
  const filename = `export_${exportId}.${format}`;
  return `exports/${userId}/${exportId}/${date}/${filename}`;
}

export interface UploadResult {
  key: string;
  size: number;
  sha256: string;
  contentType?: string;
}

export async function uploadFile(
  key: string,
  data: Buffer,
  contentType = 'application/octet-stream',
  metadata: Record<string, string> = {},
): Promise<UploadResult> {
  const sha256 = createHash('sha256').update(data).digest('hex');

  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: data,
    ContentType: contentType,
    Metadata: {
      ...metadata,
      sha256,
    },
  });

  await getB2Client().send(command);

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

export async function downloadFile(
  key: string,
  maxBytes: number,
): Promise<DownloadedFile> {
  const head = await getB2Client().send(
    new HeadObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    }),
  );

  const declaredSize = Number(head.ContentLength ?? -1);

  if (
    !Number.isInteger(declaredSize)
    || declaredSize < 0
    || declaredSize > maxBytes
  ) {
    throw new Error(
      'B2 object exceeds the permitted download size.',
    );
  }

  const response = await getB2Client().send(
    new GetObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error('B2 object body is missing.');
  }

  const bytes = await response.Body.transformToByteArray();

  if (
    bytes.byteLength !== declaredSize
    || bytes.byteLength > maxBytes
  ) {
    throw new Error('B2 object size changed during download.');
  }

  return {
    data: Buffer.from(bytes),
    size: bytes.byteLength,
    contentType: response.ContentType ?? head.ContentType,
    metadata: {
      ...(head.Metadata ?? {}),
      ...(response.Metadata ?? {}),
    },
  };
}

export async function deleteFile(key: string): Promise<void> {
  await getB2Client().send(
    new DeleteObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    }),
  );
}

export async function getSignedUrlForObject(
  key: string,
  expiresInSeconds = 15 * 60,
): Promise<string> {
  try {
    await getB2Client().send(
      new HeadObjectCommand({
        Bucket: getBucketName(),
        Key: key,
      }),
    );
  } catch {
    throw new Error(`B2 object not found: ${key}`);
  }

  const getCommand = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  return getSignedUrl(getB2Client(), getCommand, {
    expiresIn: expiresInSeconds,
  });
}

export async function verifyFile(key: string): Promise<{
  exists: boolean;
  size?: number;
  contentType?: string;
  sha256?: string;
  lastModified?: Date;
}> {
  try {
    const response = await getB2Client().send(
      new HeadObjectCommand({
        Bucket: getBucketName(),
        Key: key,
      }),
    );

    return {
      exists: true,
      size: response.ContentLength,
      contentType: response.ContentType,
      sha256: response.Metadata?.sha256,
      lastModified: response.LastModified,
    };
  } catch {
    return { exists: false };
  }
}

export const backblazeB2 = {
  generateTaskProofKey,
  generateExportKey,
  uploadFile,
  downloadFile,
  deleteFile,
  getSignedUrlForObject,
  verifyFile,
<<<<<<< HEAD
};
=======
};
>>>>>>> integrate/stage1-backbone
