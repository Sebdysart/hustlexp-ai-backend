import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptTaskLocation,
  encryptTaskLocation,
  TaskLocationCryptoError,
} from '../../src/services/TaskLocationCrypto.js';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_TASK_ID = '550e8400-e29b-41d4-a716-446655440001';
const KEY = Buffer.alloc(32, 7).toString('base64');
const ROTATED_KEY = Buffer.alloc(32, 9).toString('base64');
const originalKey = process.env.TASK_LOCATION_ENCRYPTION_KEY;
const originalKeyId = process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;
const originalPrevious = process.env.TASK_LOCATION_DECRYPTION_KEYS;

function stored(encrypted: ReturnType<typeof encryptTaskLocation>) {
  return {
    location_ciphertext: encrypted.ciphertext,
    location_nonce: encrypted.nonce,
    location_auth_tag: encrypted.authTag,
    location_key_id: encrypted.keyId,
  };
}

beforeEach(() => {
  process.env.TASK_LOCATION_ENCRYPTION_KEY = KEY;
  process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = 'location-test-v1';
  delete process.env.TASK_LOCATION_DECRYPTION_KEYS;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.TASK_LOCATION_ENCRYPTION_KEY;
  else process.env.TASK_LOCATION_ENCRYPTION_KEY = originalKey;
  if (originalKeyId === undefined) delete process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;
  else process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = originalKeyId;
  if (originalPrevious === undefined) delete process.env.TASK_LOCATION_DECRYPTION_KEYS;
  else process.env.TASK_LOCATION_DECRYPTION_KEYS = originalPrevious;
});

describe('TaskLocationCrypto', () => {
  it('round-trips an exact location without storing plaintext', () => {
    const encrypted = encryptTaskLocation(TASK_ID, '  123 Main St, Bellevue, WA 98004  ');
    expect(encrypted.ciphertext).not.toContain('123 Main');
    expect(encrypted.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(decryptTaskLocation(TASK_ID, stored(encrypted))).toBe('123 Main St, Bellevue, WA 98004');
  });

  it('uses a fresh nonce while preserving the task-bound idempotency fingerprint', () => {
    const first = encryptTaskLocation(TASK_ID, '123 Main St, Bellevue, WA 98004');
    const second = encryptTaskLocation(TASK_ID, '123 Main St, Bellevue, WA 98004');
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('rejects ciphertext replayed against another task', () => {
    const encrypted = encryptTaskLocation(TASK_ID, '123 Main St');
    expect(() => decryptTaskLocation(OTHER_TASK_ID, stored(encrypted))).toThrow(TaskLocationCryptoError);
  });

  it('rejects tampered authenticated ciphertext', () => {
    const encrypted = encryptTaskLocation(TASK_ID, '123 Main St');
    const tampered = Buffer.from(encrypted.ciphertext, 'base64');
    tampered[0] ^= 1;
    expect(() => decryptTaskLocation(TASK_ID, {
      ...stored(encrypted),
      location_ciphertext: tampered.toString('base64'),
    })).toThrow(/authentication failed/u);
  });

  it('rejects a shortened GCM authentication tag', () => {
    const encrypted = encryptTaskLocation(TASK_ID, '123 Main St');
    const shortenedTag = Buffer.from(encrypted.authTag, 'base64').subarray(0, 12).toString('base64');
    expect(() => decryptTaskLocation(TASK_ID, {
      ...stored(encrypted),
      location_auth_tag: shortenedTag,
    })).toThrow(/authentication failed/u);
  });

  it('fails closed when the current encryption key is absent or malformed', () => {
    delete process.env.TASK_LOCATION_ENCRYPTION_KEY;
    expect(() => encryptTaskLocation(TASK_ID, '123 Main St')).toThrow(/32-byte key/u);
    process.env.TASK_LOCATION_ENCRYPTION_KEY = 'not-base64';
    expect(() => encryptTaskLocation(TASK_ID, '123 Main St')).toThrow(/valid base64/u);
  });

  it('decrypts older key IDs only through the explicit rotation keyring', () => {
    const encrypted = encryptTaskLocation(TASK_ID, '123 Main St');
    process.env.TASK_LOCATION_ENCRYPTION_KEY = ROTATED_KEY;
    process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = 'location-test-v2';
    process.env.TASK_LOCATION_DECRYPTION_KEYS = JSON.stringify({ 'location-test-v1': KEY });
    expect(decryptTaskLocation(TASK_ID, stored(encrypted))).toBe('123 Main St');
  });
});
