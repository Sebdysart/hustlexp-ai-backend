import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, getFirebaseUserRecord } = vi.hoisted(() => ({
  query: vi.fn(),
  getFirebaseUserRecord: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({ db: { query } }));
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
    query.mockResolvedValue({ rows: [{ id: 'user-1', is_minor: true }] });

    await expect(ensureUserRowForFirebaseUid('firebase-1')).resolves.toMatchObject({
      id: 'user-1',
      is_minor: true,
    });

    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain("VALUES ($1, $2, $3, 'worker', $4::date, true, $5)");
    expect(params).toEqual(['firebase-1', 'adult-check@example.com', 'Adult Check', '1990-01-01', 0]);
  });
});
