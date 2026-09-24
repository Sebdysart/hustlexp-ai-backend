import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  query: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: { transaction: mocks.transaction, query: mocks.query },
}));
vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: { createInTransaction: mocks.notify },
}));

import {
  activePendingPhoneClaimUrl,
  claimPendingPhoneDraft,
  createPendingPhoneClaimInTransaction,
} from '../../src/services/CustomerDraftClaimService.js';

describe('pending phone draft ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (fn) => fn(mocks.query));
  });

  it('stores only the token hash and returns a claim URL without queuing SMS', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO pending_phone_draft_claims')) return { rows: [{ id: params?.[0] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const result = await createPendingPhoneClaimInTransaction(query, {
      taskDraftId: 'draft-1',
      normalizedPhone: '+12065550123',
      createdByOpsUserId: 'ops-1',
    });

    const claimInsert = calls.find((call) => call.sql.includes('pending_phone_draft_claims'))!;
    const claimToken = decodeURIComponent(new URL(result.claimUrl).pathname.split('/').at(-1)!);
    expect(result.claimUrl).toContain('/customer/claim/');
    expect(claimInsert.params).not.toContain(claimToken);
    expect(calls.map((call) => JSON.stringify(call.params)).join(' ')).not.toContain(claimToken);
    expect(calls.some((call) => call.sql.includes('INSERT INTO sms_outbox'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('INSERT INTO outbox_events'))).toBe(false);
  });

  it('only exposes a claim URL while the claim is open and unexpired', () => {
    const active = {
      claimId: '11111111-1111-4111-8111-111111111111',
      status: 'OPEN',
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(activePendingPhoneClaimUrl(active)).toContain('/customer/claim/');
    expect(activePendingPhoneClaimUrl({ ...active, status: 'CLAIMED' })).toBeNull();
    expect(activePendingPhoneClaimUrl({ ...active, expiresAt: new Date(Date.now() - 1) })).toBeNull();
  });

  it('atomically binds draft and lead for the matching Firebase-verified phone', async () => {
    const writes: string[] = [];
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pending_phone_draft_claims') && sql.includes('FOR UPDATE')) return { rows: [{
        id: 'claim-1', task_draft_id: 'draft-1', intended_phone_e164: '+12065550123',
        status: 'OPEN', expires_at: new Date(Date.now() + 60_000), claimed_by_user_id: null,
      }], rowCount: 1 };
      if (sql.includes('FROM users WHERE id=')) return { rows: [{ id: 'user-1', phone: null }], rowCount: 1 };
      if (sql.includes('FROM users WHERE phone=')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM task_drafts') && sql.includes('FOR UPDATE')) return { rows: [{ poster_user_id: null, lead_id: 'lead-1' }], rowCount: 1 };
      if (sql.includes('FROM leads WHERE id=') && sql.includes('FOR UPDATE')) return { rows: [{ user_id: null }], rowCount: 1 };
      if (sql.includes('SELECT id FROM quotes')) return { rows: [{ id: 'quote-1' }], rowCount: 1 };
      writes.push(sql);
      return { rows: [], rowCount: 1 };
    });

    await expect(claimPendingPhoneDraft({
      rawToken: 'opaque-token', userId: 'user-1', verifiedPhone: '+12065550123',
    })).resolves.toEqual({ taskDraftId: 'draft-1', replayed: false });
    expect(writes.some((sql) => sql.includes('UPDATE task_drafts SET poster_user_id'))).toBe(true);
    expect(writes.some((sql) => sql.includes('UPDATE leads SET user_id'))).toBe(true);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(
      mocks.query,
      expect.objectContaining({
        userId: 'user-1',
        dedupeKey: 'quote-created:quote-1',
      }),
    );
  });

  it('does not bind ownership if account eligibility changes before the phone write', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pending_phone_draft_claims')) return { rows: [{
        id: 'claim-1', task_draft_id: 'draft-1', intended_phone_e164: '+12065550123',
        status: 'OPEN', expires_at: new Date(Date.now() + 60_000), claimed_by_user_id: null,
      }], rowCount: 1 };
      if (sql.includes('FROM users WHERE id=')) return { rows: [{ id: 'user-1', firebase_uid: 'firebase-1', phone: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(claimPendingPhoneDraft({ rawToken: 'token', userId: 'user-1', verifiedPhone: '+12065550123' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE task_drafts'))).toBe(false);
  });

  it('rejects the wrong verified phone without binding ownership', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pending_phone_draft_claims')) return { rows: [{
        id: 'claim-1', task_draft_id: 'draft-1', intended_phone_e164: '+12065550123',
        status: 'OPEN', expires_at: new Date(Date.now() + 60_000), claimed_by_user_id: null,
      }], rowCount: 1 };
      if (sql.includes('FROM users WHERE id=')) return { rows: [{ id: 'user-1', phone: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(claimPendingPhoneDraft({
      rawToken: 'opaque-token', userId: 'user-1', verifiedPhone: '+12065550999',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE task_drafts'))).toBe(false);
  });

  it('makes replay deterministic for the same user and rejects a different user', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      id: 'claim-1', task_draft_id: 'draft-1', intended_phone_e164: '+12065550123',
      status: 'CLAIMED', expires_at: new Date(), claimed_by_user_id: 'user-1',
    }], rowCount: 1 });
    await expect(claimPendingPhoneDraft({
      rawToken: 'opaque-token', userId: 'user-1', verifiedPhone: '+12065550123',
    })).resolves.toEqual({ taskDraftId: 'draft-1', replayed: true });
    await expect(claimPendingPhoneDraft({
      rawToken: 'opaque-token', userId: 'user-2', verifiedPhone: '+12065550123',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each([
    ['REVOKED', new Date(Date.now() + 60_000)],
    ['EXPIRED', new Date(Date.now() + 60_000)],
    ['OPEN', new Date(Date.now() - 60_000)],
  ] as const)('rejects a %s claim without binding the draft', async (status, expiresAt) => {
    mocks.query.mockResolvedValue({ rows: [{
      id: 'claim-1', task_draft_id: 'draft-1', intended_phone_e164: '+12065550123',
      status, expires_at: expiresAt, claimed_by_user_id: null,
    }], rowCount: 1 });

    await expect(claimPendingPhoneDraft({
      rawToken: 'opaque-token', userId: 'user-1', verifiedPhone: '+12065550123',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE task_drafts'))).toBe(false);
  });
});
