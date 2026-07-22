import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));
vi.mock('../../src/config', () => ({
  config: { cloudflare: { r2: { bucketName: 'private-test-bucket' } } },
}));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

const storageMocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock('../../src/storage/r2', () => ({ r2: storageMocks }));

import { db } from '../../src/db';
import {
  expireMediaUploadReceipts,
  finalizeMediaUpload,
} from '../../src/services/MediaUploadFinalizationService';
import { consumeFinalizedMediaReceipt } from '../../src/services/MediaUploadReceiptService';

const RECEIPT_ID = 'a0000000-0000-4000-8000-000000000001';
const TASK_ID = 'b0000000-0000-4000-8000-000000000001';
const USER_ID = 'c0000000-0000-4000-8000-000000000001';
const QUARANTINE_KEY = `quarantine/proof/${TASK_ID}/${USER_ID}/${RECEIPT_ID}.jpg`;
const CANONICAL_KEY = `media/proof/${TASK_ID}/${USER_ID}/${RECEIPT_ID}.jpg`;

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    task_id: TASK_ID,
    uploader_id: USER_ID,
    purpose: 'PROOF',
    status: 'QUARANTINED',
    quarantine_key: QUARANTINE_KEY,
    expected_content_type: 'image/jpeg',
    expected_size_bytes: 1,
    canonical_key: null,
    canonical_url: null,
    canonical_content_type: null,
    canonical_size_bytes: null,
    canonical_checksum_sha256: null,
    pixel_width: null,
    pixel_height: null,
    source_metadata_detected: null,
    quarantine_expires_at: new Date(Date.now() + 60_000),
    expires_at: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

async function privateJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 3, height: 2, channels: 3, background: '#ff4f00' } })
    .jpeg()
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">GPS=47.6062,-122.3321;device=iPhone</x:xmpmeta>')
    .toBuffer();
}

describe('canonical media upload finalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.R2_PUBLIC_URL;
    storageMocks.uploadFile.mockResolvedValue({});
    storageMocks.deleteFile.mockResolvedValue(undefined);
  });

  it('re-encodes quarantine bytes, deletes the raw object, and issues canonical evidence', async () => {
    const source = await privateJpeg();
    const row = receipt({ expected_size_bytes: source.length });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
      .mockImplementationOnce(async (_sql, params) => ({
        rows: [receipt({
          ...row,
          status: 'FINALIZED',
          canonical_key: params?.[1],
          canonical_content_type: params?.[2],
          canonical_size_bytes: params?.[3],
          canonical_checksum_sha256: params?.[4],
          pixel_width: params?.[5],
          pixel_height: params?.[6],
          source_metadata_detected: params?.[7],
        })],
        rowCount: 1,
      }) as never);
    storageMocks.downloadFile.mockResolvedValue({
      data: source,
      size: source.length,
      contentType: 'image/jpeg',
      metadata: {
        'receipt-id': RECEIPT_ID,
        'task-id': TASK_ID,
        'uploaded-by': USER_ID,
        purpose: 'proof',
      },
    });

    const output = await finalizeMediaUpload({
      receiptId: RECEIPT_ID,
      taskId: TASK_ID,
      uploaderId: USER_ID,
      purpose: 'PROOF',
    }, storageMocks as never);

    expect(output).toMatchObject({
      uploadReceiptId: RECEIPT_ID,
      contentType: 'image/jpeg',
      width: 3,
      height: 2,
      sourceMetadataDetected: true,
    });
    expect(output).not.toHaveProperty('url');
    const canonicalBytes = storageMocks.uploadFile.mock.calls[0][1] as Buffer;
    expect(canonicalBytes.includes(Buffer.from('GPS=47.6062,-122.3321'))).toBe(false);
    expect(storageMocks.uploadFile).toHaveBeenCalledWith(
      CANONICAL_KEY,
      expect.any(Buffer),
      'image/jpeg',
      expect.objectContaining({
        sanitized: 'true',
        'pixel-width': '3',
        'pixel-height': '2',
        'source-metadata-detected': 'true',
      }),
    );
    expect(storageMocks.deleteFile).toHaveBeenCalledWith(QUARANTINE_KEY);
    expect(String(vi.mocked(db.query).mock.calls[1][0])).toContain("status='FINALIZED'");
  });

  it('deletes and rejects a quarantine object whose signed metadata does not match', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [receipt()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    storageMocks.downloadFile.mockResolvedValue({
      data: Buffer.from([1]),
      size: 1,
      contentType: 'image/jpeg',
      metadata: { 'receipt-id': 'attacker' },
    });

    await expect(finalizeMediaUpload({
      receiptId: RECEIPT_ID,
      taskId: TASK_ID,
      uploaderId: USER_ID,
      purpose: 'PROOF',
    }, storageMocks as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(storageMocks.deleteFile).toHaveBeenCalledWith(QUARANTINE_KEY);
    expect(storageMocks.uploadFile).not.toHaveBeenCalled();
    expect(vi.mocked(db.query).mock.calls[1][1]).toEqual([RECEIPT_ID, 'UPLOAD_ATTESTATION_MISMATCH']);
  });

  it('rejects cross-user receipt finalization before touching object storage', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [receipt()], rowCount: 1 } as never);
    await expect(finalizeMediaUpload({
      receiptId: RECEIPT_ID,
      taskId: TASK_ID,
      uploaderId: 'd0000000-0000-4000-8000-000000000001',
      purpose: 'PROOF',
    }, storageMocks as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(storageMocks.downloadFile).not.toHaveBeenCalled();
  });

  it('replays a finalized receipt without processing bytes again', async () => {
    const row = receipt({
      status: 'FINALIZED',
      canonical_key: `media/proof/${TASK_ID}/${USER_ID}/${RECEIPT_ID}.jpg`,
      canonical_url: null,
      canonical_content_type: 'image/jpeg',
      canonical_size_bytes: 300,
      canonical_checksum_sha256: 'a'.repeat(64),
      pixel_width: 3,
      pixel_height: 2,
      source_metadata_detected: true,
    });
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never);
    await expect(finalizeMediaUpload({
      receiptId: RECEIPT_ID,
      taskId: TASK_ID,
      uploaderId: USER_ID,
      purpose: 'PROOF',
    }, storageMocks as never)).resolves.toMatchObject({ uploadReceiptId: RECEIPT_ID });
    expect(storageMocks.downloadFile).not.toHaveBeenCalled();
  });

  it('recovers a verified canonical object after the receipt update was interrupted', async () => {
    const canonical = await sharp({
      create: { width: 5, height: 4, channels: 3, background: '#7c3aed' },
    }).jpeg({ quality: 92 }).toBuffer();
    const checksum = createHash('sha256').update(canonical).digest('hex');
    const quarantined = receipt({ expected_size_bytes: canonical.length });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [quarantined], rowCount: 1 } as never)
      .mockImplementationOnce(async (_sql, params) => ({
        rows: [receipt({
          ...quarantined,
          status: 'FINALIZED',
          canonical_key: params?.[1],
          canonical_content_type: params?.[2],
          canonical_size_bytes: params?.[3],
          canonical_checksum_sha256: params?.[4],
          pixel_width: params?.[5],
          pixel_height: params?.[6],
          source_metadata_detected: params?.[7],
        })],
        rowCount: 1,
      }) as never);
    storageMocks.downloadFile
      .mockRejectedValueOnce(new Error('quarantine object no longer exists'))
      .mockResolvedValueOnce({
        data: canonical,
        size: canonical.length,
        contentType: 'image/jpeg',
        metadata: {
          'receipt-id': RECEIPT_ID,
          'task-id': TASK_ID,
          'uploaded-by': USER_ID,
          purpose: 'proof',
          sanitized: 'true',
          sha256: checksum,
          'pixel-width': '5',
          'pixel-height': '4',
          'source-metadata-detected': 'false',
        },
      });

    await expect(finalizeMediaUpload({
      receiptId: RECEIPT_ID,
      taskId: TASK_ID,
      uploaderId: USER_ID,
      purpose: 'PROOF',
    }, storageMocks as never)).resolves.toMatchObject({
      uploadReceiptId: RECEIPT_ID,
      width: 5,
      height: 4,
      checksumSha256: checksum,
      sourceMetadataDetected: false,
    });
    expect(storageMocks.downloadFile).toHaveBeenNthCalledWith(1, QUARANTINE_KEY, expect.any(Number));
    expect(storageMocks.downloadFile).toHaveBeenNthCalledWith(2, CANONICAL_KEY, expect.any(Number));
    expect(storageMocks.deleteFile).not.toHaveBeenCalledWith(CANONICAL_KEY);
  });

  it('deletes a canonical recovery object when its attestation does not match the bytes', async () => {
    const canonical = await sharp({
      create: { width: 5, height: 4, channels: 3, background: '#7c3aed' },
    }).jpeg().toBuffer();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [receipt()], rowCount: 1 } as never);
    storageMocks.downloadFile
      .mockRejectedValueOnce(new Error('quarantine object no longer exists'))
      .mockResolvedValueOnce({
        data: canonical,
        size: canonical.length,
        contentType: 'image/jpeg',
        metadata: {
          'receipt-id': RECEIPT_ID,
          'task-id': TASK_ID,
          'uploaded-by': USER_ID,
          purpose: 'proof',
          sanitized: 'true',
          sha256: '0'.repeat(64),
          'pixel-width': '5',
          'pixel-height': '4',
          'source-metadata-detected': 'false',
        },
      });

    await expect(finalizeMediaUpload({
      receiptId: RECEIPT_ID,
      taskId: TASK_ID,
      uploaderId: USER_ID,
      purpose: 'PROOF',
    }, storageMocks as never)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(storageMocks.deleteFile).toHaveBeenCalledWith(CANONICAL_KEY);
  });

  it('consumes only an exact finalized receipt attestation', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      canonical_key: CANONICAL_KEY,
      canonical_content_type: 'image/jpeg',
      canonical_size_bytes: 300,
      canonical_checksum_sha256: 'a'.repeat(64),
    }], rowCount: 1 });
    await expect(consumeFinalizedMediaReceipt(query as never, {
      evidence: {
        uploadReceiptId: RECEIPT_ID,
        contentType: 'image/jpeg',
        fileSizeBytes: 300,
        checksumSha256: 'A'.repeat(64),
      },
      taskId: TASK_ID,
      uploaderId: USER_ID,
      purpose: 'PROOF',
      consumerId: 'e0000000-0000-4000-8000-000000000001',
    })).resolves.toMatchObject({ storageKey: CANONICAL_KEY });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status='FINALIZED'"), [
      RECEIPT_ID,
      TASK_ID,
      USER_ID,
      'image/jpeg',
      'PROOF',
      'e0000000-0000-4000-8000-000000000001',
      300,
      'a'.repeat(64),
    ]);

    const rejectedQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(consumeFinalizedMediaReceipt(rejectedQuery as never, {
      evidence: {
        uploadReceiptId: RECEIPT_ID,
        contentType: 'image/jpeg',
        fileSizeBytes: 300,
        checksumSha256: 'a'.repeat(64),
      },
      taskId: TASK_ID,
      uploaderId: USER_ID,
      purpose: 'PROOF',
      consumerId: 'e0000000-0000-4000-8000-000000000001',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('deletes expired raw and unconsumed canonical objects before terminalizing receipts', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [
        receipt({ quarantine_expires_at: new Date(0) }),
        receipt({
          id: 'a0000000-0000-4000-8000-000000000002',
          status: 'FINALIZED',
          canonical_key: 'media/proof/canonical.jpg',
          canonical_url: null,
          canonical_content_type: 'image/jpeg',
          canonical_size_bytes: 300,
          canonical_checksum_sha256: 'a'.repeat(64),
          pixel_width: 3,
          pixel_height: 2,
          source_metadata_detected: false,
          expires_at: new Date(0),
        }),
      ], rowCount: 2 } as never)
      .mockResolvedValue({ rows: [{ id: RECEIPT_ID }], rowCount: 1 } as never);

    await expect(expireMediaUploadReceipts(100)).resolves.toEqual({ expired: 2, failed: 0 });
    expect(storageMocks.deleteFile).toHaveBeenCalledWith(QUARANTINE_KEY);
    expect(storageMocks.deleteFile).toHaveBeenCalledWith('media/proof/canonical.jpg');
  });
});
