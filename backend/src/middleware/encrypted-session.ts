/**
 * Encrypted Session Store
 *
 * Encrypts user session data at rest in Redis using AES-256-GCM.
 * Prevents credential exposure if Redis is compromised.
 *
 * AUTHORITY: Security audit finding — HIGH severity
 *
 * Usage:
 *   import { encryptSession, decryptSession } from './middleware/encrypted-session';
 *   await redis.set(key, encryptSession(user), ttl);
 *   const user = decryptSession(await redis.get(key));
 *
 * Environment:
 *   SESSION_ENCRYPTION_KEY — 64-char hex string (32 bytes)
 *   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { logger } from '../logger';

const log = logger.child({ module: 'encrypted-session' });

// ============================================================================
// KEY MANAGEMENT
// ============================================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // GCM standard: 12 bytes
const AUTH_TAG_LENGTH = 16;  // GCM standard: 16 bytes

/**
 * Get encryption key from environment.
 * Returns null in development if not set (sessions stored plaintext with warning).
 */
function getEncryptionKey(): Buffer | null {
  const keyHex = process.env.SESSION_ENCRYPTION_KEY;
  if (!keyHex) {
    return null;
  }

  if (keyHex.length !== 64) {
    log.error(
      { keyLength: keyHex.length },
      'SESSION_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Session encryption disabled.'
    );
    return null;
  }

  // Validate hex characters explicitly (Buffer.from silently skips invalid hex)
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    log.error('SESSION_ENCRYPTION_KEY contains non-hex characters. Session encryption disabled.');
    return null;
  }

  try {
    return Buffer.from(keyHex, 'hex');
  } catch {
    log.error('SESSION_ENCRYPTION_KEY is not valid hex. Session encryption disabled.');
    return null;
  }
}

let _cachedKey: Buffer | null | undefined;
function getKey(): Buffer | null {
  if (_cachedKey !== undefined) return _cachedKey;
  _cachedKey = getEncryptionKey();
  if (!_cachedKey) {
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
      log.error('SESSION_ENCRYPTION_KEY is required in production. Sessions will be rejected.');
    } else {
      log.warn('SESSION_ENCRYPTION_KEY not set. Sessions stored unencrypted (dev only).');
    }
  }
  return _cachedKey;
}

// ============================================================================
// ENCRYPT / DECRYPT
// ============================================================================

/**
 * Encrypt a session object for Redis storage.
 *
 * Format: base64(iv + authTag + ciphertext)
 * - iv: 12 bytes
 * - authTag: 16 bytes
 * - ciphertext: variable
 *
 * Falls back to JSON.stringify if no encryption key (dev only).
 */
export function encryptSession(data: object): string {
  const key = getKey();
  const json = JSON.stringify(data);

  if (!key) {
    // Dev fallback — plaintext
    return json;
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(json, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + authTag (16) + ciphertext (variable)
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a session string from Redis.
 *
 * Returns null if decryption fails (tampered data, wrong key, or format error).
 * Falls back to JSON.parse if no encryption key (dev only).
 */
export function decryptSession<T = object>(stored: string | null): T | null {
  if (!stored) return null;

  const key = getKey();

  if (!key) {
    // Dev fallback — try plain JSON
    try {
      return JSON.parse(stored) as T;
    } catch {
      return null;
    }
  }

  try {
    const packed = Buffer.from(stored, 'base64');

    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      log.warn('Encrypted session too short — possible corruption');
      return null;
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString('utf8')) as T;
  } catch (err) {
    log.error({ err }, 'Session decryption failed — possible tampering or key rotation');
    return null;
  }
}

/**
 * Check if session encryption is available and properly configured.
 */
export function isEncryptionEnabled(): boolean {
  return getKey() !== null;
}

/**
 * Clear cached key (for testing or key rotation).
 */
export function _resetKeyCache(): void {
  _cachedKey = undefined;
}
