import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const raw = process.env.STAX_MERCHANT_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error('STAX_MERCHANT_CREDENTIAL_ENCRYPTION_KEY is required.');
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) throw new Error('STAX_MERCHANT_CREDENTIAL_ENCRYPTION_KEY must be a 64-character hexadecimal string.');
  return Buffer.from(raw, 'hex');
}

export function encryptStaxCredential(plaintext: string): string {
  if (!plaintext.trim()) throw new Error('Cannot encrypt an empty Stax credential.');
  const nonce = crypto.randomBytes(IV_LENGTH);
  const actual = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), nonce);
  const ciphertext = Buffer.concat([actual.update(plaintext, 'utf8'), actual.final()]);
  return Buffer.concat([nonce, actual.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptStaxCredential(stored: string): string {
  const data = Buffer.from(stored, 'base64');
  if (data.length <= IV_LENGTH + AUTH_TAG_LENGTH) throw new Error('Stored Stax credential is malformed.');
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), data.subarray(0, IV_LENGTH));
  decipher.setAuthTag(data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
  return Buffer.concat([decipher.update(data.subarray(IV_LENGTH + AUTH_TAG_LENGTH)), decipher.final()]).toString('utf8');
}

export function fingerprintStaxCredential(credential: string): string {
  return crypto.createHash('sha256').update(credential).digest('hex');
}
