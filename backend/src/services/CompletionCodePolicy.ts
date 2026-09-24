import crypto from 'node:crypto';

export const CODE_EXPIRY_MINUTES = 30;
export const MAX_FAILED_ATTEMPTS = 5;

function secret(): string {
  const value = process.env.COMPLETION_VERIFICATION_SECRET;
  if (!value?.trim()) throw new Error('COMPLETION_VERIFICATION_SECRET is required.');
  return value;
}

function hmac(input: string): string {
  return crypto.createHmac('sha256', secret()).update(input).digest('hex');
}

export function generateCompletionCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function completionCodeExpiresAt(): Date {
  return new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);
}

// Keep the original task-code input byte-for-byte compatible with stored hashes.
export function hashTaskCompletionCode(taskId: string, code: string): string {
  return hmac(`${taskId}:${code}`);
}

export function hashReworkCompletionCode(taskId: string, reworkId: string, code: string): string {
  return hmac(`${taskId}:${reworkId}:${code}`);
}

export function completionCodeMatches(expected: string, actual: string): boolean {
  try {
    const stored = Buffer.from(expected, 'hex');
    const candidate = Buffer.from(actual, 'hex');
    return stored.length === 32 && stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
  } catch {
    return false;
  }
}
