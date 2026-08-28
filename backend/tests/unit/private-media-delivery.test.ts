import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  signObject: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/storage/r2', () => ({
  r2: { getSignedUrlForObject: mocks.signObject },
}));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: mocks.warn, error: mocks.error, info: vi.fn() }) },
}));

import {
  issueAdminModerationMediaAccess,
  issueParticipantMediaAccess,
  issueSystemMediaAccess,
  PRIVATE_MEDIA_URL_TTL_SECONDS,
  projectModerationMediaForAdmin,
  projectProofPhotosForViewer,
  projectTaskMessagesForViewer,
} from '../../src/services/PrivateMediaDeliveryService';

const TASK_ID = '10000000-0000-4000-8000-000000000001';
const VIEWER_ID = '20000000-0000-4000-8000-000000000001';
const ADMIN_ID = '20000000-0000-4000-8000-000000000002';
const PROOF_ID = '30000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '40000000-0000-4000-8000-000000000001';
const RECEIPT_ID = '50000000-0000-4000-8000-000000000001';
const STORAGE_KEY = `media/proof/${TASK_ID}/${VIEWER_ID}/${RECEIPT_ID}.jpg`;
const MESSAGE_STORAGE_KEY = `media/message/${TASK_ID}/${VIEWER_ID}/${RECEIPT_ID}.jpg`;
const SIGNED_URL = 'https://private-r2.example/object?X-Amz-Signature=attested';

function authorizedRow(storageKey = STORAGE_KEY, consumerId = PROOF_ID) {
  return {
    ordinal: 0,
    receipt_id: RECEIPT_ID,
    task_id: TASK_ID,
    consumer_id: consumerId,
    storage_key: storageKey,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signObject.mockResolvedValue(SIGNED_URL);
});

describe('private media delivery', () => {
  it('returns a five-minute URL only after the matching audit row is stored', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [authorizedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ receipt_id: RECEIPT_ID }], rowCount: 1 });
    const now = new Date('2026-07-20T18:00:00.000Z');

    const result = await issueParticipantMediaAccess({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      purpose: 'PROOF',
      accessReason: 'PROOF_REVIEW',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query, signObject: mocks.signObject, now: () => now });

    expect(mocks.signObject).toHaveBeenCalledWith(STORAGE_KEY, PRIVATE_MEDIA_URL_TTL_SECONDS);
    expect(query.mock.calls[0]?.[0]).toContain('task.poster_id = $2 OR task.worker_id = $2');
    expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO media_access_log');
    expect(result.get(`${PROOF_ID}\u0000${STORAGE_KEY}`)).toEqual({
      downloadUrl: SIGNED_URL,
      expiresAt: '2026-07-20T18:05:00.000Z',
    });
  });

  it('returns nothing for an unauthorized or mismatched receipt and never signs it', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await issueParticipantMediaAccess({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      purpose: 'PROOF',
      accessReason: 'PROOF_REVIEW',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query, signObject: mocks.signObject });

    expect(result.size).toBe(0);
    expect(mocks.signObject).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns nothing when signing fails or produces an unsafe URL', async () => {
    const failedQuery = vi.fn().mockResolvedValueOnce({ rows: [authorizedRow()], rowCount: 1 });
    mocks.signObject.mockRejectedValueOnce(new Error('object missing'));
    await expect(issueParticipantMediaAccess({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      purpose: 'PROOF',
      accessReason: 'PROOF_REVIEW',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query: failedQuery, signObject: mocks.signObject })).resolves.toEqual(new Map());
    expect(failedQuery).toHaveBeenCalledOnce();

    const unsafeQuery = vi.fn().mockResolvedValueOnce({ rows: [authorizedRow()], rowCount: 1 });
    mocks.signObject.mockResolvedValueOnce('http://public.example/media.jpg');
    await expect(issueParticipantMediaAccess({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      purpose: 'PROOF',
      accessReason: 'PROOF_REVIEW',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query: unsafeQuery, signObject: mocks.signObject })).resolves.toEqual(new Map());
    expect(unsafeQuery).toHaveBeenCalledOnce();
  });

  it('does not release a generated URL when audit insertion fails or loses authorization', async () => {
    const failedAudit = vi.fn()
      .mockResolvedValueOnce({ rows: [authorizedRow()], rowCount: 1 })
      .mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(issueParticipantMediaAccess({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      purpose: 'PROOF',
      accessReason: 'PROOF_REVIEW',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query: failedAudit, signObject: mocks.signObject })).rejects.toThrow('audit unavailable');

    const lostAuthority = vi.fn()
      .mockResolvedValueOnce({ rows: [authorizedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await issueParticipantMediaAccess({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      purpose: 'PROOF',
      accessReason: 'PROOF_REVIEW',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query: lostAuthority, signObject: mocks.signObject });
    expect(result.size).toBe(0);
  });

  it('rejects a purpose/reason mismatch before database or storage access', async () => {
    await expect(issueParticipantMediaAccess({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      purpose: 'MESSAGE',
      accessReason: 'PROOF_REVIEW',
      references: [{ consumerId: MESSAGE_ID, storageKey: STORAGE_KEY }],
    })).rejects.toThrow('does not match');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.signObject).not.toHaveBeenCalled();
  });

  it('releases receipt-backed proof media to a system consumer only after a SYSTEM audit commits', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [authorizedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ receipt_id: RECEIPT_ID }], rowCount: 1 });
    const now = new Date('2026-07-20T18:00:00.000Z');

    const result = await issueSystemMediaAccess({
      taskId: TASK_ID,
      purpose: 'PROOF',
      accessReason: 'BIOMETRIC_ANALYSIS',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query, signObject: mocks.signObject, now: () => now });

    expect(query.mock.calls[0]?.[0]).toContain("receipt.status = 'CONSUMED'");
    expect(query.mock.calls[0]?.[0]).toContain('receipt.canonical_url IS NULL');
    expect(query.mock.calls[1]?.[0]).toContain("NULL, 'SYSTEM'");
    expect(query.mock.calls[1]?.[1]?.slice(0, 3)).toEqual([
      TASK_ID,
      'PROOF',
      'BIOMETRIC_ANALYSIS',
    ]);
    expect(result.get(`${PROOF_ID}\u0000${STORAGE_KEY}`)).toEqual({
      downloadUrl: SIGNED_URL,
      expiresAt: '2026-07-20T18:05:00.000Z',
    });
  });

  it('fails closed when system receipt authority is absent or the audit loses authority', async () => {
    const unauthorized = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const missing = await issueSystemMediaAccess({
      taskId: TASK_ID,
      purpose: 'PROOF',
      accessReason: 'BIOMETRIC_ANALYSIS',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query: unauthorized, signObject: mocks.signObject });
    expect(missing.size).toBe(0);
    expect(mocks.signObject).not.toHaveBeenCalled();

    const lostAudit = vi.fn()
      .mockResolvedValueOnce({ rows: [authorizedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const withheld = await issueSystemMediaAccess({
      taskId: TASK_ID,
      purpose: 'PROOF',
      accessReason: 'BIOMETRIC_ANALYSIS',
      references: [{ consumerId: PROOF_ID, storageKey: STORAGE_KEY }],
    }, { query: lostAudit, signObject: mocks.signObject });
    expect(withheld.size).toBe(0);
  });

  it('releases moderation media only to a current trust admin after an admin audit row commits', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [authorizedRow(MESSAGE_STORAGE_KEY, MESSAGE_ID)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ receipt_id: RECEIPT_ID }], rowCount: 1 });
    const now = new Date('2026-07-20T18:00:00.000Z');

    const result = await issueAdminModerationMediaAccess({
      adminId: ADMIN_ID,
      references: [{ consumerId: MESSAGE_ID, storageKey: MESSAGE_STORAGE_KEY }],
    }, { query, signObject: mocks.signObject, now: () => now });

    expect(query.mock.calls[0]?.[0]).toContain('role.can_modify_trust = TRUE');
    expect(query.mock.calls[1]?.[0]).toContain("'ADMIN', 'MESSAGE'");
    expect(query.mock.calls[1]?.[0]).toContain("'MODERATION_REVIEW'");
    expect(result.get(`${MESSAGE_ID}\u0000${MESSAGE_STORAGE_KEY}`)).toEqual({
      downloadUrl: SIGNED_URL,
      expiresAt: '2026-07-20T18:05:00.000Z',
    });
  });

  it('does not sign moderation media when current trust-admin authorization is absent', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await issueAdminModerationMediaAccess({
      adminId: ADMIN_ID,
      references: [{ consumerId: MESSAGE_ID, storageKey: MESSAGE_STORAGE_KEY }],
    }, { query, signObject: mocks.signObject });

    expect(result.size).toBe(0);
    expect(mocks.signObject).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });

  it('strips moderation storage keys and reports unavailability when its audit cannot commit', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [authorizedRow(MESSAGE_STORAGE_KEY, MESSAGE_ID)], rowCount: 1 })
      .mockRejectedValueOnce(new Error('audit unavailable'));

    const [item] = await projectModerationMediaForAdmin(ADMIN_ID, [{
      id: 'queue-1',
      content_type: 'photo',
      content_id: MESSAGE_ID,
      content_url: MESSAGE_STORAGE_KEY,
    }]);

    expect(item.content_url).toBeNull();
    expect(item.media_delivery_status).toBe('UNAVAILABLE');
    expect(JSON.stringify(item)).not.toContain(MESSAGE_STORAGE_KEY);
  });

  it('whitelists proof response fields and never returns the canonical key', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [authorizedRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ receipt_id: RECEIPT_ID }], rowCount: 1 });
    const [photo] = await projectProofPhotosForViewer({
      taskId: TASK_ID,
      proofId: PROOF_ID,
      viewerId: VIEWER_ID,
      photos: [{
        id: 'photo-1', proof_id: PROOF_ID, storage_key: STORAGE_KEY,
        content_type: 'image/jpeg', file_size_bytes: 300,
        checksum_sha256: 'a'.repeat(64), sequence_number: 1,
        created_at: new Date('2026-07-20T17:00:00.000Z'),
      }],
    });

    expect(photo).not.toHaveProperty('storage_key');
    expect(photo.download_url).toBe(SIGNED_URL);
    expect(JSON.stringify(photo)).not.toContain(STORAGE_KEY);
  });

  it('turns a message authorization or audit failure into explicit unavailability without key leakage', async () => {
    mocks.query.mockRejectedValueOnce(new Error('authorization database unavailable'));
    const [message] = await projectTaskMessagesForViewer({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      messages: [{
        id: MESSAGE_ID,
        task_id: TASK_ID,
        sender_id: VIEWER_ID,
        receiver_id: '60000000-0000-4000-8000-000000000001',
        message_type: 'PHOTO',
        photo_urls: [`media/message/${TASK_ID}/${VIEWER_ID}/${RECEIPT_ID}.jpg`],
        created_at: new Date('2026-07-20T17:00:00.000Z'),
        updated_at: new Date('2026-07-20T17:00:00.000Z'),
      }],
    });

    expect(message.photo_urls).toEqual([]);
    expect(message.photo_delivery_status).toBe('UNAVAILABLE');
    expect(JSON.stringify(message)).not.toContain('media/message/');
  });

  it('never authorizes, signs, or exposes a quarantined photo message to a participant', async () => {
    const [message] = await projectTaskMessagesForViewer({
      taskId: TASK_ID,
      viewerId: VIEWER_ID,
      messages: [{
        id: MESSAGE_ID,
        task_id: TASK_ID,
        sender_id: VIEWER_ID,
        receiver_id: '60000000-0000-4000-8000-000000000001',
        message_type: 'PHOTO',
        content: 'Unsafe caption',
        photo_urls: [MESSAGE_STORAGE_KEY],
        moderation_status: 'quarantined',
        moderation_flags: ['pixel_review_required'],
        created_at: new Date('2026-07-20T17:00:00.000Z'),
        updated_at: new Date('2026-07-20T17:00:00.000Z'),
      }],
    });

    expect(message.content).toBeUndefined();
    expect(message.photo_urls).toEqual([]);
    expect(message.photo_delivery_status).toBe('NONE');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.signObject).not.toHaveBeenCalled();
    expect(JSON.stringify(message)).not.toContain(MESSAGE_STORAGE_KEY);
  });
});
