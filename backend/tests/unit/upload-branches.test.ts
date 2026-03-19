/**
 * Upload Router Branch Coverage Tests
 *
 * Targets uncovered branches in upload.ts not covered by upload-router.test.ts:
 *
 * getPresignedUrl (R2 configured — s3Client non-null):
 *   - calls getSignedUrl, returns real presigned URL (not mock)
 *   - fileSize present → PutObjectCommand has ContentLength
 *   - fileSize absent → PutObjectCommand omits ContentLength
 *   - publicUrl uses bucketName when R2_PUBLIC_URL not set
 *   - publicUrl uses R2_PUBLIC_URL env var when set
 *   - Metadata includes uploaded-by and task-id
 *   - purpose=message uses messages/ prefix
 *   - purpose=proof uses proofs/ prefix
 *   - image/heic content type accepted
 *   - ContentType passed to PutObjectCommand
 *   - expiresAt is in the future
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mutable refs so vi.mock factory closures can reference them
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockPutObjectCommandCtor = vi.fn().mockImplementation(function(this: Record<string, unknown>, params: unknown) {
    // Store params so tests can inspect them
    Object.assign(this, { inputParams: params });
    return this;
  });

  const MockS3Client = vi.fn().mockImplementation(function(this: Record<string, unknown>) {
    // An instance — just needs to be truthy
    return this;
  });

  const mockGetSignedUrl = vi.fn();

  return { mockPutObjectCommandCtor, MockS3Client, mockGetSignedUrl };
});

// ---------------------------------------------------------------------------
// Mocks — MUST come before any imports that touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// R2 credentials fully configured so isR2Configured=true and s3Client is non-null
vi.mock('../../src/config', () => ({
  config: {
    cloudflare: {
      r2: {
        accountId:       'account-id-123',
        accessKeyId:     'access-key-abc',
        secretAccessKey: 'secret-key-xyz',
        bucketName:      'hustlexp-bucket',
      },
    },
  },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: mocks.MockS3Client,
  PutObjectCommand: mocks.mockPutObjectCommandCtor,
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mocks.mockGetSignedUrl,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { uploadRouter } from '../../src/routers/upload';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T_UUID = '11111111-1111-1111-1111-111111111111';

function makeCaller(userId = 'test-uid') {
  return uploadRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upload.getPresignedUrl — R2 configured (presigned URL path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getSignedUrl and returns the real presigned URL', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://real-presigned.example.com?X-Amz-Signature=abc');

    const result = await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'upload.jpg',
      contentType: 'image/jpeg',
      fileSize: 1024,
    });

    expect(mocks.mockGetSignedUrl).toHaveBeenCalledTimes(1);
    expect(result.uploadUrl).toBe('https://real-presigned.example.com?X-Amz-Signature=abc');
    expect(result.uploadUrl).not.toContain('mock');
  });

  it('includes ContentLength in PutObjectCommand when fileSize is provided', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=sz');

    await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'large.jpg',
      contentType: 'image/jpeg',
      fileSize: 2048,
    });

    // The PutObjectCommand constructor was called with params containing ContentLength
    const ctorArgs = mocks.mockPutObjectCommandCtor.mock.calls[0][0];
    expect(ctorArgs.ContentLength).toBe(2048);
  });

  it('always includes ContentLength in PutObjectCommand (fileSize is required)', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=nosz');

    await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'small.jpg',
      contentType: 'image/jpeg',
      fileSize: 512,
    });

    const ctorArgs = mocks.mockPutObjectCommandCtor.mock.calls[0][0];
    expect(ctorArgs.ContentLength).toBe(512);
  });

  it('publicUrl contains the bucket name when R2_PUBLIC_URL is not set', async () => {
    const orig = process.env.R2_PUBLIC_URL;
    delete process.env.R2_PUBLIC_URL;

    try {
      mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=pub');

      const result = await makeCaller().getPresignedUrl({
        taskId: T_UUID,
        filename: 'pub.jpg',
        contentType: 'image/jpeg',
        fileSize: 1024,
      });

      expect(result.publicUrl).toContain('hustlexp-bucket');
    } finally {
      if (orig !== undefined) process.env.R2_PUBLIC_URL = orig;
    }
  });

  it('publicUrl uses R2_PUBLIC_URL env var when set', async () => {
    const orig = process.env.R2_PUBLIC_URL;
    process.env.R2_PUBLIC_URL = 'https://cdn.hustlexp.com';

    try {
      mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=cdn');

      const result = await makeCaller().getPresignedUrl({
        taskId: T_UUID,
        filename: 'cdn.jpg',
        contentType: 'image/jpeg',
        fileSize: 1024,
      });

      expect(result.publicUrl).toContain('https://cdn.hustlexp.com');
    } finally {
      if (orig === undefined) delete process.env.R2_PUBLIC_URL;
      else process.env.R2_PUBLIC_URL = orig;
    }
  });

  it('includes uploaded-by and task-id in PutObjectCommand Metadata', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=meta');

    await makeCaller('user-abc').getPresignedUrl({
      taskId: T_UUID,
      filename: 'meta.jpg',
      contentType: 'image/jpeg',
      fileSize: 1024,
    });

    const ctorArgs = mocks.mockPutObjectCommandCtor.mock.calls[0][0];
    expect(ctorArgs.Metadata['uploaded-by']).toBe('user-abc');
    expect(ctorArgs.Metadata['task-id']).toBe(T_UUID);
  });

  it('key uses messages/ prefix for purpose=message', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=msg');

    const result = await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'chat.jpg',
      contentType: 'image/jpeg',
      purpose: 'message',
      fileSize: 2048,
    });

    expect(result.key).toContain('messages/');
    expect(result.key).not.toContain('proofs/');
    const ctorArgs = mocks.mockPutObjectCommandCtor.mock.calls[0][0];
    expect(ctorArgs.Key).toContain('messages/');
  });

  it('key uses proofs/ prefix for explicit purpose=proof', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=proof');

    const result = await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'proof.jpg',
      contentType: 'image/jpeg',
      purpose: 'proof',
      fileSize: 1024,
    });

    expect(result.key).toContain('proofs/');
    expect(result.key).not.toContain('messages/');
  });

  it('accepts image/heic content type', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=heic');

    const result = await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'photo.heic',
      contentType: 'image/heic',
      fileSize: 3000000,
    });

    expect(result.key).toContain('photo.heic');
    expect(mocks.mockGetSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('returns expiresAt in the future', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=exp');

    const before = Date.now();
    const result = await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'exp.jpg',
      contentType: 'image/jpeg',
      fileSize: 1024,
    });

    const expiresAt = new Date(result.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before);
  });

  it('passes ContentType to PutObjectCommand', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=ct');

    await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'img.webp',
      contentType: 'image/webp',
      fileSize: 1024,
    });

    const ctorArgs = mocks.mockPutObjectCommandCtor.mock.calls[0][0];
    expect(ctorArgs.ContentType).toBe('image/webp');
  });

  it('passes Bucket name to PutObjectCommand', async () => {
    mocks.mockGetSignedUrl.mockResolvedValue('https://presigned.example.com?sig=bkt');

    await makeCaller().getPresignedUrl({
      taskId: T_UUID,
      filename: 'bkt.jpg',
      contentType: 'image/jpeg',
      fileSize: 1024,
    });

    const ctorArgs = mocks.mockPutObjectCommandCtor.mock.calls[0][0];
    expect(ctorArgs.Bucket).toBe('hustlexp-bucket');
  });
});
