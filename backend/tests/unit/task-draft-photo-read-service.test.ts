import { describe, expect, it, vi } from 'vitest';
import { listDeliveredTaskDraftPhotos } from '../../src/services/TaskDraftPhotoReadService';

const DRAFT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_LINK_ID = '20000000-0000-4000-8000-000000000001';
const PHOTO_ID = '30000000-0000-4000-8000-000000000001';

describe('task draft photo read projection', () => {
  it('returns only safe client fields after private delivery authorizes the media', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: PHOTO_ID,
        upload_receipt_id: '40000000-0000-4000-8000-000000000001',
        sequence_number: 2,
        canonical_key: 'canonical/task-draft-photo/private.jpg',
        canonical_content_type: 'image/jpeg',
        canonical_size_bytes: '2048',
        pixel_width: '1200',
        pixel_height: '900',
      }],
      rowCount: 1,
    });
    const issueAccess = vi.fn().mockResolvedValue(new Map([
      [PHOTO_ID, { downloadUrl: 'https://private.example/photo?signature=test', expiresAt: '2026-09-14T00:05:00.000Z' }],
    ]));

    const result = await listDeliveredTaskDraftPhotos({
      taskDraftId: DRAFT_ID,
      authority: { kind: 'CLAIM_PREVIEW', claimLinkId: CLAIM_LINK_ID },
    }, { query, issueAccess });

    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY p.sequence_number');
    expect(issueAccess).toHaveBeenCalledWith({
      taskDraftId: DRAFT_ID,
      authority: { kind: 'CLAIM_PREVIEW', claimLinkId: CLAIM_LINK_ID },
      storageKeys: [{ photoId: PHOTO_ID, storageKey: 'canonical/task-draft-photo/private.jpg' }],
    });
    expect(result).toEqual([{
      id: PHOTO_ID,
      uploadReceiptId: '40000000-0000-4000-8000-000000000001',
      sequenceNumber: 2,
      downloadUrl: 'https://private.example/photo?signature=test',
      contentType: 'image/jpeg',
      fileSizeBytes: 2048,
      width: 1200,
      height: 900,
    }]);
    expect(result[0]).not.toHaveProperty('canonical_key');
    expect(result[0]).not.toHaveProperty('quarantine_key');
  });

  it('does not return a photo when private delivery does not authorize a URL', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: PHOTO_ID,
        upload_receipt_id: '40000000-0000-4000-8000-000000000001',
        sequence_number: 0,
        canonical_key: 'canonical/task-draft-photo/private.jpg',
        canonical_content_type: 'image/jpeg',
        canonical_size_bytes: 10,
        pixel_width: 10,
        pixel_height: 10,
      }],
      rowCount: 1,
    });
    const issueAccess = vi.fn().mockResolvedValue(new Map());

    await expect(listDeliveredTaskDraftPhotos({
      taskDraftId: DRAFT_ID,
      authority: { kind: 'CLAIM_PREVIEW', claimLinkId: CLAIM_LINK_ID },
    }, { query, issueAccess })).resolves.toEqual([]);
  });
});
