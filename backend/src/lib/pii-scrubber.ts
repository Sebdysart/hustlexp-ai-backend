/**
 * PII Scrubber v1.0.0
 *
 * Strips personally identifiable information from strings before they are
 * sent to AI/LLM providers. Handles emails, phone numbers, SSNs, credit
 * card numbers, GPS coordinates, user IDs, and likely personal names.
 *
 * @see validators.ts (Zod schemas that may contain PII fields)
 */

import { logger } from '../logger.js';

const log = logger.child({ module: 'pii-scrubber' });

// ============================================================================
// REGEX PATTERNS
// ============================================================================

/** RFC 5322-ish email pattern */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * North American phone numbers in common formats:
 *   +1 (555) 123-4567, 555-123-4567, 5551234567, (555) 123 4567, etc.
 */
const PHONE_RE =
  /(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

/** SSN: 123-45-6789 or 123 45 6789 */
const SSN_RE = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;

/**
 * Credit card numbers (13-19 digits, optionally separated by spaces or dashes).
 * Validated with a Luhn check to reduce false positives.
 */
const CC_RE = /\b(?:\d[ -]?){13,19}\b/g;

/**
 * GPS coordinates in decimal-degree format:
 *   37.7749, -122.4194 or (37.7749, -122.4194)
 */
const GPS_RE =
  /\(?\s*(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})\s*\)?/g;

/**
 * User/account ID patterns commonly found in application text:
 *   user_abc123, usr-7f3e, account_id:12345, uid_xyz
 */
const USER_ID_RE =
  /\b(?:user|usr|account|acct|uid|member|profile)[_:-]?[a-zA-Z0-9_-]{3,}\b/gi;

/**
 * Capitalised two-or-three-word sequences that look like personal names.
 * Heuristic: two or three capitalised words in a row, each 2-20 chars.
 * Deliberately conservative to avoid stripping non-name phrases.
 */
const NAME_RE =
  /\b[A-Z][a-z]{1,19}(?:\s+[A-Z][a-z]{1,19}){1,2}\b/g;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Common words that look like names but are not.
 * Kept as a Set for O(1) lookups.
 */
const NAME_FALSE_POSITIVES: ReadonlySet<string> = new Set([
  'New York', 'Los Angeles', 'San Francisco', 'San Diego', 'San Jose',
  'Las Vegas', 'El Paso', 'Fort Worth', 'Grand Rapids', 'Little Rock',
  'Baton Rouge', 'Des Moines', 'Salt Lake', 'North Carolina', 'South Carolina',
  'South Dakota', 'North Dakota', 'West Virginia', 'New Jersey', 'New Mexico',
  'New Hampshire', 'New Zealand', 'United States', 'United Kingdom',
  'Costa Rica', 'Puerto Rico', 'Hong Kong', 'Sri Lanka',
  'Monday Tuesday', 'January February', 'March April',
  'The Quick', 'Hello World', 'Dear Sir', 'Dear Madam',
  'Thank You', 'Best Regards', 'Kind Regards',
  'Terms Service', 'Privacy Policy',
]);

/**
 * Luhn check to verify a candidate credit card number.
 * Strips non-digit characters before checking.
 */
function passesLuhn(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Validate that a candidate SSN is plausible.
 * Area numbers 000, 666, and 900-999 are invalid per SSA rules.
 */
function isPlausibleSSN(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 9) return false;

  const area = parseInt(digits.slice(0, 3), 10);
  const group = parseInt(digits.slice(3, 5), 10);
  const serial = parseInt(digits.slice(5), 10);

  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0) return false;
  if (serial === 0) return false;

  return true;
}

// ============================================================================
// USER ID ANONYMISATION
// ============================================================================

/**
 * Maps original user ID tokens to anonymised replacements within a single
 * scrub invocation, so the same ID always maps to the same placeholder.
 */
function createUserIdAnonymiser(): (id: string) => string {
  const map = new Map<string, string>();
  let counter = 0;

  return (id: string): string => {
    const key = id.toLowerCase();
    const existing = map.get(key);
    if (existing) return existing;

    counter++;
    const token = `[USER_${counter}]`;
    map.set(key, token);
    return token;
  };
}

// ============================================================================
// GPS GENERALISATION
// ============================================================================

/**
 * Round a GPS coordinate to 2 decimal places (~1.1 km precision).
 * This is sufficient for neighbourhood-level identification while
 * stripping the ability to pinpoint an exact address.
 */
function generaliseCoordinate(value: string): string {
  const num = parseFloat(value);
  if (isNaN(num)) return value;
  return num.toFixed(2);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/** Options for controlling scrub behaviour. */
export interface ScrubOptions {
  /** Scrub email addresses. Default: true */
  emails?: boolean;
  /** Scrub phone numbers. Default: true */
  phones?: boolean;
  /** Scrub SSNs. Default: true */
  ssns?: boolean;
  /** Scrub credit card numbers. Default: true */
  creditCards?: boolean;
  /** Generalise GPS coordinates to neighbourhood level. Default: true */
  gps?: boolean;
  /** Anonymise user ID tokens. Default: true */
  userIds?: boolean;
  /** Strip likely personal names. Default: true */
  names?: boolean;
}

const DEFAULT_OPTIONS: Required<ScrubOptions> = {
  emails: true,
  phones: true,
  ssns: true,
  creditCards: true,
  gps: true,
  userIds: true,
  names: true,
};

/**
 * Scrub PII from a plain-text string.
 *
 * The function applies a series of regex-based transformations in a
 * deterministic order. User IDs are replaced with stable anonymous tokens
 * (`[USER_1]`, `[USER_2]`, ...) within a single call so referential
 * integrity is maintained.
 *
 * @param input  - The raw string that may contain PII.
 * @param opts   - Fine-grained control over which categories to scrub.
 * @returns        The string with PII redacted or generalised.
 */
export function scrubPII(input: string, opts?: ScrubOptions): string {
  const options: Required<ScrubOptions> = { ...DEFAULT_OPTIONS, ...opts };
  let result = input;

  // 1. Emails (before phones, since emails can contain digit runs)
  if (options.emails) {
    result = result.replace(EMAIL_RE, '[EMAIL_REDACTED]');
  }

  // 2. SSNs (before credit cards, since SSNs are shorter digit runs)
  if (options.ssns) {
    result = result.replace(SSN_RE, (match) => {
      return isPlausibleSSN(match) ? '[SSN_REDACTED]' : match;
    });
  }

  // 3. Credit card numbers (Luhn-validated to reduce false positives)
  if (options.creditCards) {
    result = result.replace(CC_RE, (match) => {
      return passesLuhn(match) ? '[CC_REDACTED]' : match;
    });
  }

  // 4. Phone numbers
  if (options.phones) {
    result = result.replace(PHONE_RE, '[PHONE_REDACTED]');
  }

  // 5. GPS coordinates -> neighbourhood level
  if (options.gps) {
    result = result.replace(GPS_RE, (_match, lat: string, lng: string) => {
      return `(${generaliseCoordinate(lat)}, ${generaliseCoordinate(lng)})`;
    });
  }

  // 6. User IDs -> anonymised tokens
  if (options.userIds) {
    const anonymise = createUserIdAnonymiser();
    result = result.replace(USER_ID_RE, (match) => anonymise(match));
  }

  // 7. Personal names (heuristic, applied last to avoid clobbering redaction labels)
  if (options.names) {
    result = result.replace(NAME_RE, (match) => {
      if (NAME_FALSE_POSITIVES.has(match)) return match;
      return '[NAME_REDACTED]';
    });
  }

  return result;
}

/**
 * Recursively scrub all string values in an object or array.
 *
 * Non-string primitives (`number`, `boolean`, `null`, `undefined`) are
 * returned as-is. The function creates a shallow structural clone -- the
 * original input is never mutated.
 *
 * @param input  - Any value. Objects and arrays are walked recursively.
 * @param opts   - Forwarded to {@link scrubPII} for each string leaf.
 * @returns        A structurally identical value with PII-scrubbed strings.
 */
export function scrubObjectPII<T>(input: T, opts?: ScrubOptions): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return scrubPII(input, opts) as unknown as T;
  }

  if (typeof input !== 'object') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => scrubObjectPII(item, opts)) as unknown as T;
  }

  if (input instanceof Date) {
    return input;
  }

  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    scrubbed[key] = scrubObjectPII(value, opts);
  }

  return scrubbed as T;
}

/**
 * Log a warning-level summary of how many redactions were applied.
 * Useful for audit trails without leaking the actual PII.
 */
export function logScrubSummary(original: string, scrubbed: string): void {
  const counts = {
    emails: (scrubbed.match(/\[EMAIL_REDACTED\]/g) ?? []).length,
    phones: (scrubbed.match(/\[PHONE_REDACTED\]/g) ?? []).length,
    ssns: (scrubbed.match(/\[SSN_REDACTED\]/g) ?? []).length,
    creditCards: (scrubbed.match(/\[CC_REDACTED\]/g) ?? []).length,
    names: (scrubbed.match(/\[NAME_REDACTED\]/g) ?? []).length,
    userIds: (scrubbed.match(/\[USER_\d+\]/g) ?? []).length,
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    log.warn(
      { redactions: counts, totalRedactions: total, originalLength: original.length },
      `Scrubbed ${total} PII occurrence(s) from input`,
    );
  }
}
