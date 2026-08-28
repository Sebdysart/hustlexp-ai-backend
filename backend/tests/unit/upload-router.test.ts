/**
 * Upload Router Unit Tests
 *
 * Tests the getPresignedUrl procedure:
 * - Valid input returns mock presigned URL (R2 not configured in test)
 * - Content type validation
 * - Filename validation
 * - File size validation
 * - Purpose-bound quarantine key and receipt creation
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

import { db } from '../../src/db';
import { uploadRouter } from '../../src/routers/upload';

const mockDb = vi.mocked(db);

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

// Shared helper: mock a successful participant check (caller is poster)
function mockParticipantCheck(userId = 'test-uid') {
  mockDb.query.mockResolvedValueOnce({
    rows: [{ poster_id: 'some-poster', worker_id: userId }],
    rowCount: 1,
  } as any);
}

function insertedQuarantineKey(): string {
  const call = mockDb.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO media_upload_receipts'));
  return String(call?.[1]?.[4] ?? '');
}

describe('upload.getPresignedUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mock presigned URL when R2 not configured', async () => {
    mockParticipantCheck();
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      fileSize: 1024,
    });

    expect(result).toHaveProperty('uploadUrl');
    expect(result).toHaveProperty('receiptId');
    expect(result).not.toHaveProperty('key');
    expect(result).toHaveProperty('expiresAt');
    expect(result.uploadUrl).toContain('mock');
    expect(insertedQuarantineKey()).toContain('quarantine/proof/');
  });

  it('uses the message quarantine namespace for message purpose', async () => {
    mockParticipantCheck();
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'chat-photo.png',
      contentType: 'image/png',
      purpose: 'message',
      fileSize: 2048,
    });

    expect(insertedQuarantineKey()).toContain('quarantine/message/');
  });

  it('uses the proof quarantine namespace by default', async () => {
    mockParticipantCheck();
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'proof.jpg',
      contentType: 'image/jpeg',
      fileSize: 512,
    });

    expect(insertedQuarantineKey()).toContain('quarantine/proof/');
  });

  it('binds the task, user, and opaque receipt ID into the quarantine key', async () => {
    mockParticipantCheck('user-123');
    const result = await makeCaller('user-123').getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      fileSize: 1024,
    });

    const key = insertedQuarantineKey();
    expect(key).toContain('user-123');
    expect(key).toMatch(
      /^quarantine\/proof\/11111111-1111-1111-1111-111111111111\/user-123\/[a-f0-9-]{36}\.jpg$/,
    );
    expect(key).toContain(result.receiptId);
  });

  it('rejects invalid content type', async () => {
    // Zod validation fires before db query — no participant check mock needed
    await expect(
      makeCaller().getPresignedUrl({
        taskId: TEST_UUID,
        filename: 'file.pdf',
        contentType: 'application/pdf' as any,
      })
    ).rejects.toThrow();
  });

  it('rejects missing fileSize (required since R2 fix)', async () => {
    await expect(
      makeCaller().getPresignedUrl({
        taskId: TEST_UUID,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      } as any)
    ).rejects.toThrow();
  });

  it('accepts image/webp content type and preserves extension in key', async () => {
    mockParticipantCheck();
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'photo.webp',
      contentType: 'image/webp',
      fileSize: 1024,
    });

    expect(insertedQuarantineKey()).toMatch(/^quarantine\/proof\/.+\.webp$/);
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
    mockParticipantCheck();
    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      fileSize: 1024,
    });

    const expiresAt = new Date(result.expiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // =========================================================================
  // IDOR checks (Bug 3 fix)
  // =========================================================================

  it('allows the worker of a task to get a presigned URL', async () => {
    // Participant check: caller is worker
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: 'some-poster', worker_id: 'test-uid' }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getPresignedUrl({
      taskId: TEST_UUID,
      filename: 'proof.jpg',
      contentType: 'image/jpeg',
      fileSize: 2048,
    });

    expect(result).toHaveProperty('uploadUrl');
  });

  it('throws FORBIDDEN when caller is not a participant in the task', async () => {
    // Participant check: caller is a random third party
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: 'other-poster', worker_id: 'other-worker' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().getPresignedUrl({
        taskId: TEST_UUID,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        fileSize: 1024,
      })
    ).rejects.toThrow('Only the assigned worker can upload completion proof');
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().getPresignedUrl({
        taskId: TEST_UUID,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        fileSize: 1024,
      })
    ).rejects.toThrow('Task not found');
  });
});
