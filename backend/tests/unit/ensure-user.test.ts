import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, getFirebaseUserRecord } = vi.hoisted(() => ({
  query: vi.fn(),
  getFirebaseUserRecord: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({ db: { query, transaction: (fn: (q: typeof query) => unknown) => fn(query) } }));
vi.mock('../../src/auth/firebase.js', () => ({ getFirebaseUserRecord }));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { ensureUserRowForFirebaseUid } from '../../src/auth/ensure-user.js';

describe('ensureUserRowForFirebaseUid adult safety', () => {
  beforeEach(() => {
    query.mockReset();
    getFirebaseUserRecord.mockReset();
  });

  it('fail-closes a lazily provisioned worker until age is completed through onboarding', async () => {
    getFirebaseUserRecord.mockResolvedValue({
      email: 'adult-check@example.com',
      displayName: 'Adult Check',
    });
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1', is_minor: true }] });

    await expect(ensureUserRowForFirebaseUid('firebase-1')).resolves.toMatchObject({
      id: 'user-1',
      is_minor: true,
    });

    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('VALUES ($1, $2, $3, $4, $5, $6::date, true, $7,');
    expect(params).toEqual(['firebase-1', 'adult-check@example.com', null, 'Adult Check', 'worker', '1990-01-01', 0]);
  });

  it('provisions a phone-only Firebase identity without a synthetic email', async () => {
    getFirebaseUserRecord.mockResolvedValue({
      phoneNumber: '+12065550123',
      displayName: null,
    });
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-phone', email: null, phone: '+12065550123' }] });

    await expect(ensureUserRowForFirebaseUid('firebase-phone')).resolves.toMatchObject({
      id: 'user-phone', email: null, phone: '+12065550123',
    });

    expect(query.mock.calls[2][1]).toEqual([
      'firebase-phone', null, '+12065550123', 'HustleXP customer', 'poster', '1990-01-01', 1,
    ]);
  });

  it('rejects a verified phone already bound to another Firebase user', async () => {
    getFirebaseUserRecord.mockResolvedValue({ phoneNumber: '+12065550123' });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'other-user', firebase_uid: 'other-firebase', phone_verified_at: new Date() }] });

    await expect(ensureUserRowForFirebaseUid('firebase-phone')).rejects.toMatchObject({
      applicationCode: 'PHONE_ALREADY_LINKED',
    });
  });
});
