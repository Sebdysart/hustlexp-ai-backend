/**
 * Upload Router Unit Tests
 *
 * Tests the getPresignedUrl procedure:
 * - Valid input returns mock presigned URL (R2 not configured in test)
 * - Content type validation
 * - Filename validation
 * - File size validation
 * - Purpose-based key prefix (proof vs message)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
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

vi.mock('../../src/config', () => ({
  config: {
    cloudflare: {
      r2: {
        accountId: '',
        accessKeyId: '',
        secretAccessKey: '',
        bucketName: 'test-bucket',
      },
    },
  },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  PutObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { uploadRouter } from '../../src/routers/upload';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';

function makeCaller(userId = 'test-uid') {
  return uploadRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upload.getPresignedUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mock presigned URL when R2 not configured', async () => {
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });

    expect(result).toHaveProperty('uploadUrl');
    expect(result).toHaveProperty('publicUrl');
    expect(result).toHaveProperty('key');
    expect(result).toHaveProperty('expiresAt');
    expect(result.uploadUrl).toContain('mock');
    expect(result.key).toContain('proofs/');
  });

  it('uses messages prefix for message purpose', async () => {
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'chat-photo.png',
      contentType: 'image/png',
      purpose: 'message',
    });

    expect(result.key).toContain('messages/');
  });

  it('uses proofs prefix by default', async () => {
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'proof.jpg',
      contentType: 'image/jpeg',
    });

    expect(result.key).toContain('proofs/');
  });

  it('includes task ID and user ID in key', async () => {
    const result = await makeCaller('user-123').getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });

    expect(result.key).toContain(TEST_UUID);
    expect(result.key).toContain('user-123');
  });

  it('rejects invalid content type', async () => {
    await expect(
      makeCaller().getPresignedUrl({
        taskId: TEST_UUID,
        filename: 'file.pdf',
        contentType: 'application/pdf' as any,
      })
    ).rejects.toThrow();
  });

  it('accepts image/webp content type', async () => {
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'photo.webp',
      contentType: 'image/webp',
    });

    expect(result.key).toContain('photo.webp');
  });

  it('rejects filenames with invalid characters', async () => {
    await expect(
      makeCaller().getPresignedUrl({
        taskId: TEST_UUID,
        filename: 'file with spaces.jpg',
        contentType: 'image/jpeg',
      })
    ).rejects.toThrow();
  });

  it('rejects empty filenames', async () => {
    await expect(
      makeCaller().getPresignedUrl({
        taskId: TEST_UUID,
        filename: '',
        contentType: 'image/jpeg',
      })
    ).rejects.toThrow();
  });

  it('rejects unauthenticated users', async () => {
    const caller = uploadRouter.createCaller({
      user: null,
      firebaseUid: null,
    } as any);

    await expect(
      caller.getPresignedUrl({
        taskId: TEST_UUID,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      })
    ).rejects.toThrow();
  });

  it('expiresAt is in the future', async () => {
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });

    const expiresAt = new Date(result.expiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
