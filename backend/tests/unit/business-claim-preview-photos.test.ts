import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  listPhotos: vi.fn(),
}));

vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/services/BusinessClaimService', () => ({
  claimBusinessTask: vi.fn(),
  quoteAfterAssessment: vi.fn(),
}));
vi.mock('../../src/services/BusinessAssessmentService', () => ({
  requestBusinessAssessment: vi.fn(),
}));
vi.mock('../../src/services/TaskDraftPhotoReadService', () => ({
  listDeliveredTaskDraftPhotos: mocks.listPhotos,
}));

import { businessClaimRouter } from '../../src/routers/businessClaim';

const TOKEN = 'a'.repeat(64);
const CLAIM_LINK_ID = '10000000-0000-4000-8000-000000000001';
const DRAFT_ID = '20000000-0000-4000-8000-000000000001';

function caller() {
  return businessClaimRouter.createCaller({ user: null, firebaseUid: null } as any);
}

function previewableRow(overrides: Record<string, unknown> = {}) {
  return {
    claim_link_id: CLAIM_LINK_ID,
    task_draft_id: DRAFT_ID,
    status: 'OPEN',
    expires_at: new Date(Date.now() + 60_000),
    title: 'Move a table',
    category: 'moving',
    scope_summary: 'Move one table.',
    raw_input: 'Move one table.',
    zip: '12345',
    region: 'Test',
    est_price_min_cents: 1000,
    est_price_max_cents: 2000,
    quote_id: null,
    structured: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPhotos.mockResolvedValue([]);
});

describe('businessClaim.listPreviewPhotos', () => {
  it('returns photos for the draft resolved from a valid open claim token', async () => {
    const photos = [{
      id: '30000000-0000-4000-8000-000000000001',
      uploadReceiptId: '40000000-0000-4000-8000-000000000001',
      sequenceNumber: 0,
      downloadUrl: 'https://private.example/photo?signature=test',
      contentType: 'image/jpeg',
      fileSizeBytes: 1234,
      width: 800,
      height: 600,
    }];
    mocks.query.mockResolvedValueOnce({ rows: [previewableRow()], rowCount: 1 });
    mocks.listPhotos.mockResolvedValueOnce(photos);

    await expect(caller().listPreviewPhotos({ token: TOKEN })).resolves.toEqual(photos);
    expect(mocks.query.mock.calls[0]?.[1]?.[0]).not.toBe(TOKEN);
    expect(mocks.listPhotos).toHaveBeenCalledWith({
      taskDraftId: DRAFT_ID,
      authority: { kind: 'CLAIM_PREVIEW', claimLinkId: CLAIM_LINK_ID },
    });
  });

  it('returns an empty list for a valid claim whose draft has no photos', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [previewableRow()], rowCount: 1 });
    await expect(caller().listPreviewPhotos({ token: TOKEN })).resolves.toEqual([]);
  });

  it('rejects invalid and expired tokens before requesting signed media', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(caller().listPreviewPhotos({ token: TOKEN })).rejects.toThrow('no longer available');
    expect(mocks.listPhotos).not.toHaveBeenCalled();

    mocks.query.mockResolvedValueOnce({
      rows: [previewableRow({ expires_at: new Date(Date.now() - 1_000) })],
      rowCount: 1,
    });
    await expect(caller().listPreviewPhotos({ token: TOKEN })).rejects.toThrow('no longer available');
    expect(mocks.listPhotos).not.toHaveBeenCalled();
  });

  it.each(['CLAIMED', 'EXPIRED', 'REVOKED'])('rejects non-previewable %s claim links', async (status) => {
    mocks.query.mockResolvedValueOnce({ rows: [previewableRow({ status })], rowCount: 1 });
    await expect(caller().listPreviewPhotos({ token: TOKEN })).rejects.toThrow('no longer available');
    expect(mocks.listPhotos).not.toHaveBeenCalled();
  });

  it('rejects an open token once the draft has a quote', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [previewableRow({ quote_id: '50000000-0000-4000-8000-000000000001' })],
      rowCount: 1,
    });
    await expect(caller().listPreviewPhotos({ token: TOKEN })).rejects.toThrow('no longer available');
    expect(mocks.listPhotos).not.toHaveBeenCalled();
  });

  it('does not accept a client-controlled taskDraftId', async () => {
    await expect(caller().listPreviewPhotos({
      token: TOKEN,
      taskDraftId: '90000000-0000-4000-8000-000000000009',
    } as any)).rejects.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.listPhotos).not.toHaveBeenCalled();
  });

  it('binds each token to the draft and claim link returned by its own validation query', async () => {
    const secondDraft = '20000000-0000-4000-8000-000000000002';
    const secondLink = '10000000-0000-4000-8000-000000000002';
    mocks.query
      .mockResolvedValueOnce({ rows: [previewableRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [previewableRow({ claim_link_id: secondLink, task_draft_id: secondDraft })], rowCount: 1 });

    await caller().listPreviewPhotos({ token: TOKEN });
    await caller().listPreviewPhotos({ token: 'b'.repeat(64) });

    expect(mocks.listPhotos.mock.calls.map(([input]) => input)).toEqual([
      { taskDraftId: DRAFT_ID, authority: { kind: 'CLAIM_PREVIEW', claimLinkId: CLAIM_LINK_ID } },
      { taskDraftId: secondDraft, authority: { kind: 'CLAIM_PREVIEW', claimLinkId: secondLink } },
    ]);
  });

  it('uses the same previewability check as businessClaim.preview', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [previewableRow({ status: 'REVOKED' })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [previewableRow({ status: 'REVOKED' })], rowCount: 1 });

    await expect(caller().preview({ token: TOKEN })).rejects.toThrow('no longer available');
    await expect(caller().listPreviewPhotos({ token: TOKEN })).rejects.toThrow('no longer available');
  });
});
