import { describe, expect, it, vi } from 'vitest';
import {
  issueTaskDraftPhotoAccess,
  PRIVATE_MEDIA_URL_TTL_SECONDS,
} from '../../src/services/PrivateMediaDeliveryService';

const DRAFT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_LINK_ID = '20000000-0000-4000-8000-000000000001';
const PHOTO_ID = '30000000-0000-4000-8000-000000000001';
const STORAGE_KEY = 'canonical/task-draft-photo/private.jpg';

describe('task draft photo access audit', () => {
  it('records claim preview access against the claim link without inventing a viewer', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const signObject = vi.fn().mockResolvedValue('https://private.example/photo?signature=test');
    const now = new Date('2026-09-14T00:00:00.000Z');

    const result = await issueTaskDraftPhotoAccess({
      taskDraftId: DRAFT_ID,
      authority: { kind: 'CLAIM_PREVIEW', claimLinkId: CLAIM_LINK_ID },
      storageKeys: [{ photoId: PHOTO_ID, storageKey: STORAGE_KEY }],
    }, { query, signObject, now: () => now });

    expect(signObject).toHaveBeenCalledWith(STORAGE_KEY, PRIVATE_MEDIA_URL_TTL_SECONDS);
    expect(query.mock.calls[0]?.[0]).toContain('task_draft_media_access_log');
    expect(query.mock.calls[0]?.[1]).toEqual([
      DRAFT_ID,
      PHOTO_ID,
      null,
      'CLAIM_PREVIEW',
      CLAIM_LINK_ID,
      '2026-09-14T00:05:00.000Z',
      null,
    ]);
    expect(result.get(PHOTO_ID)?.downloadUrl).toContain('https://private.example/');
  });

  it('preserves authenticated viewer auditing for the existing endpoint', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const signObject = vi.fn().mockResolvedValue('https://private.example/photo?signature=test');
    const viewerId = '40000000-0000-4000-8000-000000000001';

    await issueTaskDraftPhotoAccess({
      taskDraftId: DRAFT_ID,
      authority: { kind: 'AUTHENTICATED', viewerId },
      storageKeys: [{ photoId: PHOTO_ID, storageKey: STORAGE_KEY }],
    }, { query, signObject });

    expect(query.mock.calls[0]?.[1]?.slice(0, 5)).toEqual([
      DRAFT_ID,
      PHOTO_ID,
      viewerId,
      'AUTHENTICATED',
      null,
    ]);
  });
});

it('records the explicit Provider OS organization and authenticated actor', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const signObject = vi.fn().mockResolvedValue('https://private.example/photo?signature=test');
  await issueTaskDraftPhotoAccess({ taskDraftId: DRAFT_ID,
    authority: { kind: 'PROVIDER_OS', viewerId: 'actor', organizationId: 'org' },
    storageKeys: [{ photoId: PHOTO_ID, storageKey: STORAGE_KEY }],
  }, { query, signObject, now: () => new Date('2026-09-14T00:00:00Z') });
  expect(query.mock.calls[0][1]).toEqual([
    DRAFT_ID, PHOTO_ID, 'actor', 'PROVIDER_OS', null, '2026-09-14T00:05:00.000Z', 'org',
  ]);
});
