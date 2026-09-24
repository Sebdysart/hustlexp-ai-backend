import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFirebaseUserRecord } = vi.hoisted(() => ({ getFirebaseUserRecord: vi.fn() }));
vi.mock('../../src/auth/firebase.js', () => ({ getFirebaseUserRecord }));
import { prepareVerifiedPhoneAssignment } from '../../src/auth/verified-phone.js';

describe('verified phone identity compatibility', () => {
  const query = vi.fn();
  beforeEach(() => { query.mockReset(); getFirebaseUserRecord.mockReset(); });

  it('allows a Firebase-verified phone with no existing owner', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(prepareVerifiedPhoneAssignment(query, 'firebase-b', '+12065550123')).resolves.toBeUndefined();
  });

  it('preserves the same Firebase identity and rejects a different verified owner', async () => {
    query.mockResolvedValue({ rows: [{ id: 'a', firebase_uid: 'firebase-a', phone_verified_at: new Date(), email: 'a@example.com' }] });
    await expect(prepareVerifiedPhoneAssignment(query, 'firebase-a', '+12065550123')).resolves.toBeUndefined();
    await expect(prepareVerifiedPhoneAssignment(query, 'firebase-b', '+12065550123')).rejects.toMatchObject({ applicationCode: 'PHONE_ALREADY_LINKED' });
  });

  it('checks legacy phone against Firebase before freeing a squatted contact number', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'a', firebase_uid: 'firebase-a', phone_verified_at: null, email: 'a@example.com' }] }).mockResolvedValue({ rows: [] });
    getFirebaseUserRecord.mockResolvedValue({ uid: 'firebase-a', email: 'a@example.com' });
    await prepareVerifiedPhoneAssignment(query, 'firebase-b', '+12065550123');
    expect(getFirebaseUserRecord).toHaveBeenCalledWith('firebase-a');
    expect(query.mock.calls.some(([sql]) => /contact_phone = COALESCE\(contact_phone, phone\)/.test(sql))).toBe(true);
  });

  it('does not evict an existing legitimate phone user without a verification timestamp', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'a', firebase_uid: 'firebase-a', phone_verified_at: null, email: null }] });
    getFirebaseUserRecord.mockResolvedValue({ phoneNumber: '+12065550123' });
    await expect(prepareVerifiedPhoneAssignment(query, 'firebase-b', '+12065550123')).rejects.toMatchObject({ applicationCode: 'PHONE_ALREADY_LINKED' });
    expect(query.mock.calls.some(([sql]) => /SET phone = NULL/.test(sql))).toBe(false);
  });

  it('fails closed when legacy Firebase verification is unavailable', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'a', firebase_uid: 'firebase-a', phone_verified_at: null, email: 'a@example.com' }] });
    getFirebaseUserRecord.mockRejectedValue(new Error('Firebase unavailable'));
    await expect(prepareVerifiedPhoneAssignment(query, 'firebase-b', '+12065550123')).rejects.toThrow('Firebase unavailable');
    expect(query.mock.calls.some(([sql]) => /SET phone = NULL/.test(sql))).toBe(false);
  });
});
