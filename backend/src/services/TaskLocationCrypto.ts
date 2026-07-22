import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CURRENT_KEY_ENV = 'TASK_LOCATION_ENCRYPTION_KEY';
const CURRENT_KEY_ID_ENV = 'TASK_LOCATION_ENCRYPTION_KEY_ID';
const PREVIOUS_KEYS_ENV = 'TASK_LOCATION_DECRYPTION_KEYS';

export class TaskLocationCryptoError extends Error {
  constructor(
    readonly code: 'LOCATION_ENCRYPTION_UNAVAILABLE' | 'LOCATION_DECRYPTION_FAILED' | 'INVALID_LOCATION',
    message: string,
  ) {
    super(message);
    this.name = 'TaskLocationCryptoError';
  }
}

export interface EncryptedTaskLocation {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyId: string;
  fingerprint: string;
}

export interface StoredEncryptedTaskLocation {
  location_ciphertext: string | null;
  location_nonce: string | null;
  location_auth_tag: string | null;
  location_key_id: string | null;
}

function decodeKey(encoded: string | undefined, source: string): Buffer {
  if (!encoded) {
    throw new TaskLocationCryptoError(
      'LOCATION_ENCRYPTION_UNAVAILABLE',
      `${source} must contain a base64-encoded 32-byte key`,
    );
  }
  const compact = encoded.trim();
  const key = Buffer.from(compact, 'base64');
  const canonical = key.toString('base64').replace(/=+$/u, '');
  if (key.length !== KEY_BYTES || canonical !== compact.replace(/=+$/u, '')) {
    throw new TaskLocationCryptoError(
      'LOCATION_ENCRYPTION_UNAVAILABLE',
      `${source} must contain a valid base64-encoded 32-byte key`,
    );
  }
  return key;
}

function currentKeyId(): string {
  const keyId = process.env[CURRENT_KEY_ID_ENV]?.trim() || 'location-v1';
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new TaskLocationCryptoError(
      'LOCATION_ENCRYPTION_UNAVAILABLE',
      `${CURRENT_KEY_ID_ENV} must be 1-64 safe identifier characters`,
    );
  }
  return keyId;
}

function previousKeys(): Record<string, string> {
  const raw = process.env[PREVIOUS_KEYS_ENV]?.trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Record<string, string>;
  } catch {
    throw new TaskLocationCryptoError(
      'LOCATION_ENCRYPTION_UNAVAILABLE',
      `${PREVIOUS_KEYS_ENV} must be a JSON object mapping key IDs to base64 keys`,
    );
  }
}

function keyForDecryption(keyId: string): Buffer {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new TaskLocationCryptoError('LOCATION_DECRYPTION_FAILED', 'Stored location key ID is invalid');
  }
  if (keyId === currentKeyId()) return decodeKey(process.env[CURRENT_KEY_ENV], CURRENT_KEY_ENV);
  const previous = previousKeys()[keyId];
  if (!previous) {
    throw new TaskLocationCryptoError('LOCATION_DECRYPTION_FAILED', 'Stored location key is unavailable');
  }
  try {
    return decodeKey(previous, `${PREVIOUS_KEYS_ENV}.${keyId}`);
  } catch {
    throw new TaskLocationCryptoError('LOCATION_DECRYPTION_FAILED', 'Stored location key is unavailable');
  }
}

function normalizeLocation(exactLocation: string): string {
  const normalized = exactLocation.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 500) {
    throw new TaskLocationCryptoError('INVALID_LOCATION', 'Exact location must be between 1 and 500 characters');
  }
  return normalized;
}

function aad(taskId: string, keyId: string): Buffer {
  return Buffer.from(`hustlexp:task-location:v1:${keyId}:${taskId}`, 'utf8');
}

function fingerprint(taskId: string, exactLocation: string, key: Buffer): string {
  return createHmac('sha256', key)
    .update(`hustlexp:task-location-fingerprint:v1:${taskId}\0${exactLocation}`, 'utf8')
    .digest('hex');
}

export function encryptTaskLocation(taskId: string, exactLocation: string): EncryptedTaskLocation {
  const normalized = normalizeLocation(exactLocation);
  const keyId = currentKeyId();
  const key = decodeKey(process.env[CURRENT_KEY_ENV], CURRENT_KEY_ENV);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad(taskId, keyId));
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyId,
    fingerprint: fingerprint(taskId, normalized, key),
  };
}

/** Fail production startup before accepting traffic when the current vault key is unusable. */
export function assertTaskLocationCryptoConfigured(): void {
  currentKeyId();
  decodeKey(process.env[CURRENT_KEY_ENV], CURRENT_KEY_ENV);
  previousKeys();
}

export function decryptTaskLocation(
  taskId: string,
  stored: StoredEncryptedTaskLocation,
): string {
  const { location_ciphertext, location_nonce, location_auth_tag, location_key_id } = stored;
  if (!location_ciphertext || !location_nonce || !location_auth_tag || !location_key_id) {
    throw new TaskLocationCryptoError('LOCATION_DECRYPTION_FAILED', 'Encrypted location payload is incomplete');
  }
  try {
    const key = keyForDecryption(location_key_id);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(location_nonce, 'base64'), {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad(taskId, location_key_id));
    decipher.setAuthTag(Buffer.from(location_auth_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(location_ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof TaskLocationCryptoError) throw error;
    throw new TaskLocationCryptoError('LOCATION_DECRYPTION_FAILED', 'Exact location authentication failed');
  }
}

export function fingerprintsMatch(left: string | null | undefined, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
