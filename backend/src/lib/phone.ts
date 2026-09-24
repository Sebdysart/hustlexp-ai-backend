import crypto from 'node:crypto';

export class InvalidPhoneNumberError extends Error {
  readonly code = 'INVALID_PHONE_NUMBER';

  constructor() {
    super('Enter a valid US phone number.');
    this.name = 'InvalidPhoneNumberError';
  }
}

/** Normalize the initial US-market phone formats to canonical E.164. */
export function normalizePhoneToE164(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new InvalidPhoneNumberError();

  if (trimmed.startsWith('+') && !trimmed.startsWith('+1')) {
    throw new InvalidPhoneNumberError();
  }

  const digits = trimmed.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;

  if (national.length !== 10 || national[0] === '0' || national[0] === '1') {
    throw new InvalidPhoneNumberError();
  }

  return `+1${national}`;
}

export function hashNormalizedPhone(phone: string): string {
  return crypto.createHash('sha256').update(phone, 'utf8').digest('hex');
}

export function maskPhone(phone: string): string {
  return `(***) ***-${phone.slice(-4)}`;
}
