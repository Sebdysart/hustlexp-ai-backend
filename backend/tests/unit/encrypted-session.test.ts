/**
 * Encrypted Session Tests
 *
 * Verifies AES-256-GCM encryption/decryption for Redis session store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  encryptSession,
  decryptSession,
  isEncryptionEnabled,
  _resetKeyCache,
} from '../../src/middleware/encrypted-session';

// Valid 32-byte key (64 hex chars)
const TEST_KEY = 'a'.repeat(64);

describe('Encrypted Session Store', () => {
  beforeEach(() => {
    _resetKeyCache();
  });

  afterEach(() => {
    delete process.env.SESSION_ENCRYPTION_KEY;
    _resetKeyCache();
  });

  describe('Without encryption key (dev mode)', () => {
    it('should store as plain JSON when no key set', () => {
      const user = { uid: 'user-1', email: 'test@test.com' };
      const encrypted = encryptSession(user);
      expect(encrypted).toBe(JSON.stringify(user));
    });

    it('should decrypt plain JSON', () => {
      const user = { uid: 'user-1', email: 'test@test.com' };
      const stored = JSON.stringify(user);
      const decrypted = decryptSession(stored);
      expect(decrypted).toEqual(user);
    });

    it('should report encryption disabled', () => {
      expect(isEncryptionEnabled()).toBe(false);
    });
  });

  describe('With encryption key', () => {
    beforeEach(() => {
      process.env.SESSION_ENCRYPTION_KEY = TEST_KEY;
      _resetKeyCache();
    });

    it('should encrypt data (output differs from input)', () => {
      const user = { uid: 'user-1', email: 'test@test.com' };
      const encrypted = encryptSession(user);
      expect(encrypted).not.toBe(JSON.stringify(user));
      expect(encrypted).not.toContain('user-1');
      expect(encrypted).not.toContain('test@test.com');
    });

    it('should decrypt back to original data', () => {
      const user = { uid: 'user-1', email: 'test@test.com', emailVerified: true };
      const encrypted = encryptSession(user);
      const decrypted = decryptSession(encrypted);
      expect(decrypted).toEqual(user);
    });

    it('should produce different ciphertexts for same input (random IV)', () => {
      const user = { uid: 'user-1' };
      const enc1 = encryptSession(user);
      const enc2 = encryptSession(user);
      expect(enc1).not.toBe(enc2); // Random IV makes each unique
    });

    it('should return null for tampered ciphertext', () => {
      const user = { uid: 'user-1' };
      const encrypted = encryptSession(user);
      // Corrupt one character
      const corrupted = encrypted.slice(0, -2) + 'XX';
      const result = decryptSession(corrupted);
      expect(result).toBeNull();
    });

    it('should return null for empty input', () => {
      expect(decryptSession(null)).toBeNull();
      expect(decryptSession('')).toBeNull();
    });

    it('should return null for too-short ciphertext', () => {
      const result = decryptSession(Buffer.from('short').toString('base64'));
      expect(result).toBeNull();
    });

    it('should handle complex nested objects', () => {
      const complex = {
        uid: 'user-1',
        email: 'test@test.com',
        roles: ['admin', 'user'],
        meta: { loginCount: 5, lastIp: '127.0.0.1' },
      };
      const encrypted = encryptSession(complex);
      const decrypted = decryptSession(encrypted);
      expect(decrypted).toEqual(complex);
    });

    it('should report encryption enabled', () => {
      expect(isEncryptionEnabled()).toBe(true);
    });
  });

  describe('Invalid key handling', () => {
    it('should disable encryption for wrong-length key', () => {
      process.env.SESSION_ENCRYPTION_KEY = 'tooshort';
      _resetKeyCache();
      expect(isEncryptionEnabled()).toBe(false);
    });

    it('should disable encryption for non-hex key', () => {
      process.env.SESSION_ENCRYPTION_KEY = 'z'.repeat(64); // z is not valid hex
      _resetKeyCache();
      expect(isEncryptionEnabled()).toBe(false);
    });
  });

  describe('Key rotation scenario', () => {
    it('should return null when decrypting with wrong key', () => {
      process.env.SESSION_ENCRYPTION_KEY = TEST_KEY;
      _resetKeyCache();
      const encrypted = encryptSession({ uid: 'user-1' });

      // Rotate to new key
      process.env.SESSION_ENCRYPTION_KEY = 'b'.repeat(64);
      _resetKeyCache();
      const decrypted = decryptSession(encrypted);
      expect(decrypted).toBeNull(); // Old ciphertext cannot be decrypted
    });
  });
});
